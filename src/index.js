import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import cron from 'node-cron';
import { DateTime } from 'luxon';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
async function requireAuth(req, res, next) {
  try {
    // 1. Read Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing Authorization header' });
    }

    // 2. Extract JWT token
    const token = authHeader.replace('Bearer ', '');

    // 3. Validate token with Supabase
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const user = data.user;

    // 4. Find which business this user belongs to
    const { data: mapping, error: mapError } = await supabase
      .from('business_users')
      .select('business_id, role')
      .eq('user_id', user.id)
      .single();

    if (mapError || !mapping) {
      return res.status(403).json({ error: 'User not linked to business' });
    }

    // 5. Attach to request object
    req.user = user;
    req.businessId = mapping.business_id;
    req.role = mapping.role;

    // 6. Continue to actual API
    next();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
function formatAppointmentTime(utcISO, timezone) {
  return DateTime
    .fromISO(utcISO, { zone: 'UTC' })
    .setZone(timezone)
    .toFormat('dd LLL, hh:mm a');
}


app.get('/me', requireAuth, async (req, res) => {
  try {
    const { data: business, error } = await supabase
      .from('businesses')
      .select('id, name, timezone, appointment_settings')
      .eq('id', req.businessId)
      .single();

    if (error || !business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    res.json({
      user: {
        id: req.user.id,
        email: req.user.email,
        role: req.role,
      },
      business,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function sendWhatsAppMessage(phone, text) {
  try {
    const params = new URLSearchParams();
    params.append('channel', 'whatsapp');
    params.append('source', process.env.GUPSHUP_SOURCE_NUMBER);
    params.append('destination', phone);
    params.append(
      'message',
      JSON.stringify({
        type: 'text',
        text: text
      })
    );
    params.append('src.name', process.env.GUPSHUP_APP_NAME);

    const response = await axios.post(
      'https://api.gupshup.io/wa/api/v1/msg',
      params.toString(),
      {
        headers: {
          apikey: process.env.GUPSHUP_API_KEY,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    return {
      status: response.data?.status || 'submitted'
    };
  } catch (error) {
    console.error('Gupshup send error:', error.response?.data || error.message);
    return {
      status: 'failed'
    };
  }
}

async function sendAndLogSystemMessage({
  customerId,
  phone,
  businessTimezone,
  content,
}) {
  // 1️⃣ Insert into messages table
  const { data: message, error } = await supabase
    .from('messages')
    .insert({
      customer_id: customerId,
      direction: 'out',
      content,
      status: 'sent',
      message_type: 'system',
    })
    .select()
    .single();

  if (error) {
    console.error('Failed to log system message:', error.message);
    // still attempt WhatsApp send
  }

  // 2️⃣ Send WhatsApp message
  await sendWhatsAppMessage(phone, content);

  return message;
}


// test route
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/businesses', async (req, res) => {
  const { name, city, whatsapp_number } = req.body;

  if (!name || !whatsapp_number) {
    return res.status(400).json({
      error: 'name and whatsapp_number are required'
    });
  }

  const { data, error } = await supabase
    .from('businesses')
    .insert([
      { name, city, whatsapp_number }
    ])
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

app.post('/webhook/whatsapp', async (req, res) => {
  try {
    const eventType = req.body?.type;

    // Only process incoming messages
    if (eventType !== 'message') {
      return res.sendStatus(200);
    }

    const payload = req.body.payload;

    const phone = payload?.sender?.phone;
    const text = payload?.payload?.text;

    if (!phone || !text) {
      console.log('Ignored webhook (no text / phone)');
      return res.sendStatus(200);
    }

    console.log(`📩 Incoming WhatsApp from ${phone}: ${text}`);

    // 1️⃣ Get business (TEMP: first business)
    const { data: business, error: bizError } = await supabase
      .from('businesses')
      .select('*')
      .limit(1)
      .single();

    if (bizError || !business) {
      console.error('No business found');
      return res.sendStatus(200);
    }

    // 2️⃣ Find or create customer
    let { data: customer } = await supabase
      .from('customers')
      .select('*')
      .eq('phone', phone)
      .eq('business_id', business.id)
      .single();

    if (!customer) {
      const { data: newCustomer } = await supabase
        .from('customers')
        .insert([
          {
            business_id: business.id,
            phone
          }
        ])
        .select()
        .single();

      customer = newCustomer;
    }

    // 3️⃣ Save incoming message
    await supabase.from('messages').insert([
      {
        customer_id: customer.id,
        direction: 'in',
        content: text
      }
    ]);

    console.log('✅ Message stored successfully');

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook processing error:', err);
    res.sendStatus(200); // always 200 for WhatsApp
  }
});

app.get('/customers', requireAuth, async (req, res) => {
  const businessId = req.businessId;

  const { data, error } = await supabase.rpc(
    'get_customers_with_last_message',
    {
      business_uuid: businessId,
      user_uuid: req.user.id,
    }
  );


  if (error) {
    return res.status(500).json({ error: error.message });
  }
  console.log('AUTH HEADER:', req.headers.authorization);
  res.json(data);
});


app.get('/customers/:id/messages', requireAuth, async (req, res) => {
  const { id } = req.params;
  const businessId = req.businessId;

  // First: verify customer belongs to this business
  const { data: customer, error: customerError } = await supabase
    .from('customers')
    .select('id')
    .eq('id', id)
    .eq('business_id', businessId)
    .single();

  if (customerError || !customer) {
    return res.status(404).json({ error: 'Customer not found' });
  }

  // Then: fetch messages
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('customer_id', id)
    .order('created_at');

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

app.get('/services', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('services')
    .select('*')
    .eq('business_id', req.businessId)
    .eq('is_active', true)
    .order('created_at');

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/services', requireAuth, async (req, res) => {
  if (req.role !== 'owner') {
    return res.status(403).json({ error: 'Only owner can add services' });
  }

  const { name, duration_minutes } = req.body;

  if (!name || !duration_minutes) {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const { data, error } = await supabase
    .from('services')
    .insert({
      business_id: req.businessId,
      name,
      duration_minutes,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/services/:id', requireAuth, async (req, res) => {
  const businessId = req.businessId;
  const { id } = req.params;
  const { name, duration_minutes, is_active } = req.body;

  const updates = {};
  if (name !== undefined) updates.name = name;
  if (duration_minutes !== undefined) updates.duration_minutes = duration_minutes;
  if (is_active !== undefined) updates.is_active = is_active;

  const { data, error } = await supabase
    .from('services')
    .update(updates)
    .eq('id', id)
    .eq('business_id', businessId)
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

app.post('/appointments', requireAuth, async (req, res) => {
  try {
    console.log("CREATE APPOINTMENT payload:", req.body);

    const businessId = req.businessId;

    const {
      phone,
      name,
      service,
      duration_minutes,
      appointment_utc_time,
    } = req.body;

    if (!phone || !appointment_utc_time || !duration_minutes) {
      return res.status(400).json({ error: 'Invalid appointment payload' });
    }

    /* --------------------------------------------------
       1️⃣ Find or create customer
    -------------------------------------------------- */

    let { data: customer } = await supabase
      .from('customers')
      .select('*')
      .eq('business_id', businessId)
      .eq('phone', phone)
      .single();

    if (!customer) {
      const { data: created, error } = await supabase
        .from('customers')
        .insert({
          business_id: businessId,
          phone,
          name: name || null,
        })
        .select()
        .single();

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      customer = created;
    } else if (!customer.name && name) {
      // backfill name if missing
      await supabase
        .from('customers')
        .update({ name })
        .eq('id', customer.id);
    }

    /* --------------------------------------------------
       2️⃣ Calculate slot minutes (UTC)
    -------------------------------------------------- */

    const appointmentDate = new Date(appointment_utc_time);
    const slot_minutes =
      appointmentDate.getUTCHours() * 60 +
      appointmentDate.getUTCMinutes();

    /* --------------------------------------------------
       3️⃣ Fetch business appointment settings
    -------------------------------------------------- */

    const { data: business, error: bizError } = await supabase
      .from('businesses')
      .select('appointment_settings, timezone') 
      .eq('id', businessId)
      .single();

    if (bizError) {
      return res.status(500).json({ error: bizError.message });
    }

    const maxPerSlot =
      business?.appointment_settings?.max_appointments_per_slot ?? 1;

    /* --------------------------------------------------
       4️⃣ Enforce slot capacity
    -------------------------------------------------- */

    const { count, error: countError } = await supabase
      .from('appointments')
      .select('*', { count: 'exact', head: true })
      .eq('business_id', businessId)
      .eq('status', 'scheduled')
      .eq('slot_minutes', slot_minutes);


    if (countError) {
      return res.status(500).json({ error: countError.message });
    }

    if (count >= maxPerSlot) {
      return res.status(409).json({
        error: 'Selected time slot is fully booked',
      });
    }

    /* --------------------------------------------------
       5️⃣ Create appointment
    -------------------------------------------------- */

    const { data: appointment, error: insertError } = await supabase
      .from('appointments')
      .insert({
        business_id: businessId,
        customer_id: customer.id,
        service,
        duration_minutes,
        appointment_time: appointment_utc_time,
        slot_minutes,
        status: 'scheduled',
      })
      .select('*, customers(phone)')
      .single();

    // 📩 Send WhatsApp confirmation
    const formattedTime = formatAppointmentTime(
      appointment.appointment_time,
      business.timezone || 'UTC'
    );

    const message = `
✅ Your appointment is confirmed.

🛎 Service: ${appointment.service}
📅 Date & Time: ${formattedTime}

Reply here if you need to reschedule.
`.trim();

    await sendAndLogSystemMessage({
      customerId: customer.id,
      phone: customer.phone,
      businessTimezone: business.timezone,
      content: message,
    });


    ////
    if (insertError) {
      return res.status(500).json({ error: insertError.message });
    }

    res.json(appointment);
  } catch (err) {
    console.error('Create appointment error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


app.post('/conversations/read', requireAuth, async (req, res) => {
  const { customer_id } = req.body;

  if (!customer_id) {
    return res.status(400).json({ error: 'customer_id is required' });
  }

  try {
    const { error } = await supabase
      .from('conversation_reads')
      .upsert(
        {
          business_id: req.businessId,
          customer_id,
          user_id: req.user.id,
          last_read_at: new Date().toISOString(),
        },
        {
          onConflict: 'business_id,customer_id,user_id',
        }
      );

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.get('/appointments/upcoming', requireAuth, async (req, res) => {
  const businessId = req.businessId;

  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('appointments')
    .select(`
      id,
      service,
      appointment_time,
      status,
      customers (
        id,
        phone,
        name
      )
    `)
    .eq('business_id', businessId)
    .eq('status', 'scheduled')
    .gte('appointment_time', now)
    .order('appointment_time', { ascending: true })
    .is('archived_at', null);


  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

app.get('/appointments/next', requireAuth, async (req, res) => {
  const businessId = req.businessId;
  const { customerId } = req.query;

  if (!customerId) {
    return res.status(400).json({ error: 'customerId is required' });
  }

  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('appointments')
    .select(`
      id,
      service,
      appointment_time,
      status
    `)
    .eq('business_id', businessId)
    .eq('customer_id', customerId)
    .eq('status', 'scheduled')
    .gte('appointment_time', now)
    .order('appointment_time', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    return res.status(500).json({ error: error.message });
  }


  res.json(data);
});

app.get('/appointments', requireAuth, async (req, res) => {
  const businessId = req.businessId;
  try {
    const { data, error } = await supabase
      .from('appointments')
      .select(`
        id,
        customer_id,
        service,
        appointment_time,
        status,
        customers (
          id,
          name,
          phone
        )
      `)
      .eq('business_id', businessId)
      .order('status', {
        ascending: true,
        foreignTable: undefined
      })
      .order('appointment_time', { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    // Reorder in-memory to ensure:
    // 1. scheduled first
    // 2. past later
    const upcoming = [];
    const past = [];

    for (const appt of data) {
      if (appt.status === 'scheduled') {
        upcoming.push(appt);
      } else {
        past.push(appt);
      }
    }

    res.json([...upcoming, ...past]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

cron.schedule('* * * * *', async () => {
  try {
    console.log('Running automation rules check...');

    // Get ALL businesses
    const { data: businesses } = await supabase
      .from('businesses')
      .select('*');

    if (!businesses?.length) return;

    // Loop through each business
    for (const business of businesses) {
      // Get enabled rules for this business
      const { data: rules } = await supabase
        .from('automation_rules')
        .select('*')
        .eq('business_id', business.id)
        .eq('enabled', true);

      if (!rules?.length) continue;

      // Use Luxon instead of Date
      const now = DateTime.now().toUTC();

      for (const rule of rules) {
        // Calculate time windows using Luxon
        const from = now.plus({ minutes: rule.offset_minutes - 1 });
        const to = now.plus({ minutes: rule.offset_minutes });

        const { data: appointments } = await supabase
          .from('appointments')
          .select(`
            id,
            service,
            appointment_time,
            customers ( phone )
          `)
          .eq('business_id', business.id)
          .eq('status', 'scheduled')
          .gte('appointment_time', from.toISO())
          .lte('appointment_time', to.toISO());

        if (!appointments?.length) continue;

        for (const appt of appointments) {
          // Check if this rule already fired
          const { data: alreadySent } = await supabase
            .from('automation_logs')
            .select('id')
            .eq('appointment_id', appt.id)
            .eq('rule_id', rule.id)
            .maybeSingle();

          if (alreadySent) continue;

          // Convert UTC appointment time to business timezone
          const appointmentDateTime = DateTime.fromISO(appt.appointment_time, { zone: 'UTC' });
          const businessTz = business.timezone || 'UTC';
          const localTime = appointmentDateTime.setZone(businessTz).toFormat('yyyy-MM-dd hh:mm a');

          // Build message
          let message = rule.message_template
            .replace('{{service}}', appt.service || 'your service')
            .replace('{{appointment_time}}', localTime);

          const sendResult = await sendWhatsAppMessage(
            appt.customers.phone,
            message
          );

          if (sendResult.status === 'submitted') {
            await supabase.from('automation_logs').insert([
              {
                appointment_id: appt.id,
                rule_id: rule.id
              }
            ]);

            console.log(
              `Rule ${rule.id} executed for appointment ${appt.id} (Business: ${business.id})`
            );
          }
        }
      }
    }
  } catch (err) {
    console.error('Automation cron error:', err.message);
  }
});

async function autoMarkNoShows() {
  try {
    const now = DateTime.now().toUTC();

    // 1️⃣ Get businesses with their no-show grace settings
    const { data: businesses, error: bizError } = await supabase
      .from('businesses')
      .select('id, appointment_settings');

    if (bizError || !businesses?.length) {
      console.error('Failed to load businesses for no-show check');
      return;
    }

    for (const business of businesses) {
      const graceMinutes =
        business.appointment_settings?.no_show_grace_minutes ?? 30;

      // 2️⃣ Get scheduled appointments for this business
      const { data: appointments, error: apptError } = await supabase
        .from('appointments')
        .select('id, appointment_time')
        .eq('business_id', business.id)
        .eq('status', 'scheduled');

      if (apptError || !appointments?.length) continue;

      // 3️⃣ Find overdue appointments
      const overdueIds = appointments
        .filter(appt => {
          const apptTime = DateTime.fromISO(appt.appointment_time, {
            zone: 'UTC',
          });
          const noShowAt = apptTime.plus({ minutes: graceMinutes });

          return now > noShowAt;
        })
        .map(a => a.id);

      if (overdueIds.length === 0) continue;

      // 4️⃣ Mark them as no-show
      const { error: updateError } = await supabase
        .from('appointments')
        .update({ status: 'no_show' })
        .in('id', overdueIds);

      if (updateError) {
        console.error(
          `No-show update failed for business ${business.id}`,
          updateError.message
        );
      } else {
        console.log(
          `Auto-marked ${overdueIds.length} appointment(s) as no_show for business ${business.id}`
        );
      }
    }
  } catch (err) {
    console.error('Auto no-show cron error:', err.message);
  }
}


cron.schedule('* * * * *', autoMarkNoShows);

cron.schedule('0 3 * * *', async () => {
  // runs daily at 3 AM server time
  try {
    console.log('Archiving old cancelled / no-show appointments');

    const cutoff = DateTime.now()
      .minus({ days: 5 })
      .toUTC()
      .toISO();

    const { error } = await supabase
      .from('appointments')
      .update({ archived_at: new Date().toISOString() })
      .in('status', ['cancelled', 'no_show'])
      .lt('appointment_time', cutoff)
      .is('archived_at', null);

    if (error) {
      console.error('Archive cron error:', error.message);
    }
  } catch (err) {
    console.error('Archive cron crash:', err.message);
  }
});

//

app.patch('/appointments/:id/status', requireAuth, async (req, res) => {
  const businessId = req.businessId;
  const { id } = req.params;
  const { status } = req.body;

  const allowedStatuses = ['completed', 'no_show', 'cancelled'];

  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({
      error: 'Invalid status'
    });
  }

  try {
    // Ensure appointment belongs to this business
    const { data: appointment, error: fetchError } = await supabase
      .from('appointments')
      .select('id, status')
      .eq('id', id)
      .eq('business_id', businessId)
      .single();

    if (fetchError || !appointment) {
      return res.status(404).json({
        error: 'Appointment not found'
      });
    }

    // Update status explicitly
    const { data, error } = await supabase
      .from('appointments')
      .update({ status })
      .eq('id', id)
      .select('*, customers(phone)')
      .single();


    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/businesses/settings/appointments', requireAuth, async (req, res) => {
  const businessId = req.businessId;

  // 🔒 Owner-only
  if (req.role !== 'owner') {
    return res.status(403).json({ error: 'Only owner can update settings' });
  }

  const {
    reminder_24h,
    reminder_2h,
    no_show_grace_minutes,
    max_appointments_per_slot,
  } = req.body;

  // Basic validation
  if (
    typeof reminder_24h !== 'boolean' ||
    typeof reminder_2h !== 'boolean' ||
    typeof no_show_grace_minutes !== 'number' ||
    typeof max_appointments_per_slot !== 'number'
  ) {
    return res.status(400).json({ error: 'Invalid settings payload' });
  }

  const { data, error } = await supabase
    .from('businesses')
    .update({
      appointment_settings: {
        reminder_24h,
        reminder_2h,
        no_show_grace_minutes,
        max_appointments_per_slot,
      },
    })
    .eq('id', businessId)
    .select('appointment_settings')
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }
  /* 🔄 SYNC REMINDER SETTINGS → AUTOMATION RULES */

  // 24h reminder
  await supabase
    .from('automation_rules')
    .update({ enabled: reminder_24h })
    .eq('business_id', businessId)
    .eq('rule_type', 'reminder_24h');

  // 2h reminder
  await supabase
    .from('automation_rules')
    .update({ enabled: reminder_2h })
    .eq('business_id', businessId)
    .eq('rule_type', 'reminder_2h');

  res.json(data.appointment_settings);
});

app.get('/appointments/availability', requireAuth, async (req, res) => {
  const businessId = req.businessId;
  const { date, excludeAppointmentId } = req.query;

  if (!date) {
    return res.status(400).json({ error: 'date is required (YYYY-MM-DD)' });
  }

  // Start/end of day in UTC
  const dayStart = `${date}T00:00:00Z`;
  const dayEnd = `${date}T23:59:59Z`;

  // Fetch scheduled appointments for that day
  let query = supabase
    .from('appointments')
    .select('appointment_time')
    .eq('business_id', businessId)
    .eq('status', 'scheduled')
    .gte('appointment_time', dayStart)
    .lte('appointment_time', dayEnd);

  if (excludeAppointmentId) {
    query = query.neq('id', excludeAppointmentId);
  }

  const { data: appointments, error } = await query;


  if (error) {
    return res.status(500).json({ error: error.message });
  }

  // Count appointments per slot (minutes since midnight)
  const counts = {};

  for (const appt of appointments) {
    const dateObj = new Date(appt.appointment_time);
    const minutes =
      dateObj.getUTCHours() * 60 + dateObj.getUTCMinutes();

    counts[minutes] = (counts[minutes] || 0) + 1;
  }

  res.json({ slots: counts });
});

app.patch(
  '/appointments/:id/reschedule-slot',
  requireAuth,
  async (req, res) => {
    try {
      const businessId = req.businessId;
      const appointmentId = req.params.id;

      const { appointment_utc_time, duration_minutes } = req.body;

      if (!appointment_utc_time || !duration_minutes) {
        return res.status(400).json({ error: 'Invalid payload' });
      }

      // 1️⃣ Verify appointment
      const { data: appointment } = await supabase
        .from('appointments')
        .select('*')
        .eq('id', appointmentId)
        .eq('business_id', businessId)
        .single();

      if (!appointment) {
        return res.status(404).json({ error: 'Appointment not found' });
      }

      // 2️⃣ Compute slot minutes (UTC)
      const d = new Date(appointment_utc_time);
      const slot_minutes =
        d.getUTCHours() * 60 + d.getUTCMinutes();

      // 3️⃣ Fetch business capacity
      const { data: biz } = await supabase
        .from('businesses')
        .select('appointment_settings')
        .eq('id', businessId)
        .single();

      const maxPerSlot =
        biz?.appointment_settings?.max_appointments_per_slot ?? 1;

      // 4️⃣ Capacity check (exclude self)
      const { count } = await supabase
        .from('appointments')
        .select('*', { count: 'exact', head: true })
        .eq('business_id', businessId)
        .eq('status', 'scheduled')
        .eq('slot_minutes', slot_minutes)
        .neq('id', appointmentId);

      if (count >= maxPerSlot) {
        return res
          .status(409)
          .json({ error: 'Slot fully booked' });
      }

      // 5️⃣ Update appointment
      const { data: updated, error } = await supabase
        .from('appointments')
        .update({
          appointment_time: appointment_utc_time,
          slot_minutes,
          duration_minutes,
          status: 'scheduled',
        })
        .eq('id', appointmentId)
        .select('*, customers(phone)')
        .single();

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      const { data: business } = await supabase
        .from('businesses')
        .select('timezone')
        .eq('id', businessId)
        .single();

      const formattedTime = formatAppointmentTime(
        updated.appointment_time,
        business.timezone || 'UTC'
      );

      const message = `
🔁 Your appointment has been rescheduled.

🛎 Service: ${updated.service}
📅 New time: ${formattedTime}

Reply here if you need help.
`.trim();

      await sendAndLogSystemMessage({
        customerId: updated.customer_id,
        phone: updated.customers.phone,
        content: message,
      });

      // 6️⃣ Clear automation logs
      await supabase
        .from('automation_logs')
        .delete()
        .eq('appointment_id', appointmentId);

      res.json(updated);
    } catch (err) {
      console.error('Reschedule error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);


app.get('/automation-rules', requireAuth, async (req, res) => {
  const businessId = req.businessId;

  const { data, error } = await supabase
    .from('automation_rules')
    .select('*')
    .eq('business_id', businessId)
    .order('offset_minutes');

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

app.get('/businesses/settings/appointments', requireAuth, async (req, res) => {
  const businessId = req.businessId;

  const { data, error } = await supabase
    .from('businesses')
    .select('appointment_settings')
    .eq('id', businessId)
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  // ✅ Safe defaults (VERY IMPORTANT)
  const settings = {
    reminder_24h: data.appointment_settings?.reminder_24h ?? true,
    reminder_2h: data.appointment_settings?.reminder_2h ?? false,
    no_show_grace_minutes:
      data.appointment_settings?.no_show_grace_minutes ?? 30,
    max_appointments_per_slot:
      data.appointment_settings?.max_appointments_per_slot ?? 1,
  };

  res.json(settings);
});


app.patch('/automation-rules/:ruleId', requireAuth, async (req, res) => {
  const { ruleId } = req.params;
  const businessId = req.businessId;
  const { enabled, offset_minutes, message_template } = req.body;

  const updates = {};
  if (enabled !== undefined) updates.enabled = enabled;
  if (offset_minutes !== undefined) updates.offset_minutes = offset_minutes;
  if (message_template !== undefined)
    updates.message_template = message_template;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  const { data, error } = await supabase
    .from('automation_rules')
    .update(updates)
    .eq('id', ruleId)
    .eq('business_id', businessId)
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});
app.post('/messages/send', requireAuth, async (req, res) => {
  const { customer_id, text } = req.body;
  const businessId = req.businessId;

  if (!customer_id || !text) {
    return res.status(400).json({ error: 'customer_id and text are required' });
  }

  // 1️⃣ Verify customer belongs to this business
  const { data: customer, error: customerError } = await supabase
    .from('customers')
    .select('id, phone')
    .eq('id', customer_id)
    .eq('business_id', businessId)
    .single();

  if (customerError || !customer) {
    return res.status(404).json({ error: 'Customer not found' });
  }
  // 1️⃣ Insert message first
  const { data: message, error: insertError } = await supabase
    .from('messages')
    .insert([
      {
        customer_id,
        direction: 'out',
        content: text,
        status: 'pending'
      }
    ])
    .select()
    .single();

  if (insertError) {
    return res.status(500).json({ error: insertError.message });
  }

  // 2️⃣ Try sending WhatsApp
  try {
    const sendResult = await sendWhatsAppMessage(customer.phone, text);

    // 3️⃣ Mark as sent
    await supabase
      .from('messages')
      .update({
        status: 'sent'
      })
      .eq('id', message.id);

    res.json({ ...message, status: 'sent' });

  } catch (err) {
    // 4️⃣ Mark as failed
    await supabase
      .from('messages')
      .update({
        status: 'failed',
        error: err.message,
        retry_count: 1
      })
      .eq('id', message.id);

    res.json({ ...message, status: 'failed' });
  }

});
async function retryFailedMessages() {
  const { data: messages } = await supabase
    .from('messages')
    .select('*')
    .eq('status', 'failed')
    .lt('retry_count', 3)
    .limit(10);

  for (const msg of messages || []) {
    try {
      await supabase
        .from('messages')
        .update({ status: 'retrying' })
        .eq('id', msg.id);

      const customer = await getCustomerPhone(msg.customer_id);
      await sendWhatsAppMessage(customer.phone, msg.content);

      await supabase
        .from('messages')
        .update({ status: 'sent' })
        .eq('id', msg.id);

    } catch (err) {
      await supabase
        .from('messages')
        .update({
          status: 'failed',
          retry_count: msg.retry_count + 1,
          error: err.message
        })
        .eq('id', msg.id);
    }
  }
}
setInterval(retryFailedMessages, 5 * 60 * 1000);

app.listen(process.env.PORT, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});
