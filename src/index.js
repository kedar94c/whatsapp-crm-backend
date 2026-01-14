import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import cron from 'node-cron';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
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
    const phone = req.body?.sender?.phone;
    const text = req.body?.message?.text;

    if (!phone || !text) {
      console.log('Invalid webhook payload');
      return res.sendStatus(200);
    }

    // 1️⃣ Get first business (TEMP)
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
    console.log(`Message saved from ${phone}: ${text}`);
    res.sendStatus(200);
       // 4️⃣ Send auto-reply (TEMP)
    const replyText = 'Thanks for contacting us! We will get back to you shortly.';
const sendResult = await sendWhatsAppMessage(phone, replyText);

// Save outgoing message
await supabase.from('messages').insert([
  {
    customer_id: customer.id,
    direction: 'out',
    content: replyText,
    status: sendResult.status
  }
]);

  } catch (error) {
  console.error('Gupshup error status:', error.response?.status);
  console.error('Gupshup error data:', error.response?.data);
  console.error('Gupshup error headers:', error.response?.headers);
  }

});

app.get('/customers', async (req, res) => {
  try {
    // TEMP: single business
    const { data: business } = await supabase
      .from('businesses')
      .select('*')
      .limit(1)
      .single();

    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    const { data, error } = await supabase.rpc('get_customers_with_last_message', {
      business_uuid: business.id
    });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get('/customers/:customerId/messages', async (req, res) => {
  const { customerId } = req.params;

  const { data, error } = await supabase
    .from('messages')
    .select('id, direction, content, status, created_at')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: true });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});
app.post('/appointments', async (req, res) => {
  const { customer_id, service, appointment_time } = req.body;

  if (!customer_id || !appointment_time) {
    return res.status(400).json({
      error: 'customer_id and appointment_time are required'
    });
  }

  // TEMP: single business
  const { data: business } = await supabase
    .from('businesses')
    .select('*')
    .limit(1)
    .single();

  if (!business) {
    return res.status(404).json({ error: 'Business not found' });
  }

  const { data, error } = await supabase
    .from('appointments')
    .insert([
      {
        business_id: business.id,
        customer_id,
        service,
        appointment_time
      }
    ])
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});
app.get('/appointments/upcoming', async (req, res) => {
  // TEMP: single business
  const { data: business } = await supabase
    .from('businesses')
    .select('*')
    .limit(1)
    .single();

  if (!business) {
    return res.status(404).json({ error: 'Business not found' });
  }

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
    .eq('business_id', business.id)
    .eq('status', 'scheduled')
    .gte('appointment_time', now)
    .order('appointment_time', { ascending: true });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});
cron.schedule('* * * * *', async () => {
  try {
    console.log('Running automation rules check...');

    // TEMP: single business
    const { data: business } = await supabase
      .from('businesses')
      .select('*')
      .limit(1)
      .single();

    if (!business) return;

    // Get enabled rules
    const { data: rules } = await supabase
      .from('automation_rules')
      .select('*')
      .eq('business_id', business.id)
      .eq('enabled', true);

    if (!rules?.length) return;

    const now = new Date();

    for (const rule of rules) {
      const from = new Date(
        now.getTime() + (rule.offset_minutes - 1) * 60 * 1000
      );
      const to = new Date(
        now.getTime() + rule.offset_minutes * 60 * 1000
      );

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
        .gte('appointment_time', from.toISOString())
        .lte('appointment_time', to.toISOString());

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

        // Build message
        const message = rule.message_template.replace(
          '{{service}}',
          appt.service || 'your service'
        );

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
            `Rule ${rule.id} executed for appointment ${appt.id}`
          );
        }
      }
    }
  } catch (err) {
    console.error('Automation cron error:', err.message);
  }
});

app.get('/automation-rules', async (req, res) => {
  // TEMP: single business
  const { data: business } = await supabase
    .from('businesses')
    .select('*')
    .limit(1)
    .single();

  if (!business) {
    return res.status(404).json({ error: 'Business not found' });
  }

  const { data, error } = await supabase
    .from('automation_rules')
    .select('id, rule_type, offset_minutes, message_template, enabled')
    .eq('business_id', business.id)
    .order('offset_minutes');

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});
app.patch('/automation-rules/:ruleId', async (req, res) => {
  const { ruleId } = req.params;
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
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

app.listen(process.env.PORT, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});
