import Stripe from 'stripe';
import { Resend } from 'resend';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const rawBody = Buffer.concat(chunks).toString('utf-8');

  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { service, customerName, uploadUrl, message } = session.metadata;
    const email = session.customer_email || session.customer_details?.email;

    console.log(`✅ Order received: ${service} for ${customerName} (${email})`);
    console.log(`   Upload URL: ${uploadUrl}`);

    // Send confirmation email
    try {
      await resend.emails.send({
        from: 'Envision Legacy <orders@envisionlegacy.com>',
        to: email,
        subject: `Your ${getServiceName(service)} Order — We're On It!`,
        html: buildConfirmationEmail({ customerName, service, uploadUrl, message }),
      });
    } catch (emailErr) {
      console.error('Confirmation email failed:', emailErr);
    }

    // Send notification to business owner
    try {
      await resend.emails.send({
        from: 'Envision Legacy <orders@envisionlegacy.com>',
        to: process.env.OWNER_EMAIL || 'orders@envisionlegacy.com',
        subject: `🎉 New Order: ${getServiceName(service)} from ${customerName}`,
        html: buildOwnerNotification({ customerName, email, service, uploadUrl, message, amount: session.amount_total }),
      });
    } catch (emailErr) {
      console.error('Owner notification email failed:', emailErr);
    }

    // TODO Phase 2: Trigger automated animation generation here
    // if (service === 'animate' || service === 'bundle') {
    //   await triggerAnimation(uploadUrl, email, customerName);
    // }
  }

  return res.status(200).json({ received: true });
}

function getServiceName(service) {
  const names = {
    animate: 'Photo Animation',
    voice: 'Voice Clone',
    avatar: 'AI Avatar',
    bundle: 'Full Legacy Bundle',
  };
  return names[service] || service;
}

function buildConfirmationEmail({ customerName, service, uploadUrl, message }) {
  const name = customerName || 'there';
  return `
    <div style="font-family: 'Georgia', serif; max-width: 600px; margin: 0 auto; background: #f8f4ee; padding: 40px; border-radius: 12px;">
      <div style="text-align: center; margin-bottom: 30px;">
        <h1 style="font-family: 'Arial Black', sans-serif; font-size: 24px; letter-spacing: 3px; color: #1a1a1a; margin: 0;">ENVISION LEGACY</h1>
        <p style="color: #8b775a; font-style: italic; margin: 4px 0 0;">Where Memories Live Again</p>
      </div>
      <div style="background: white; padding: 32px; border-radius: 8px; border: 1px solid #e8e0d4;">
        <h2 style="color: #1a1a1a; margin-top: 0;">Thank you, ${name}!</h2>
        <p style="color: #555; line-height: 1.7;">
          We've received your <strong>${getServiceName(service)}</strong> order and our team is bringing your memory to life.
        </p>
        <div style="background: #f8f4ee; padding: 16px; border-radius: 8px; margin: 20px 0; border-left: 3px solid #c4793a;">
          <p style="margin: 0; color: #555; font-size: 14px;">
            <strong>What happens next:</strong><br>
            We'll process your ${service === 'animate' ? 'photo' : service === 'voice' ? 'voice recording' : 'photos'} and send you the finished result within 24 hours.
          </p>
        </div>
        ${message ? `<p style="color: #888; font-style: italic; font-size: 14px;">Your note: "${message}"</p>` : ''}
        <p style="color: #555; line-height: 1.7;">
          If you have any questions, simply reply to this email.
        </p>
        <p style="color: #c4793a; font-style: italic;">With warmth,<br>The Envision Legacy Team</p>
      </div>
    </div>
  `;
}

function buildOwnerNotification({ customerName, email, service, uploadUrl, message, amount }) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px;">
      <h2>🎉 New Order Received!</h2>
      <table style="border-collapse: collapse; width: 100%;">
        <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Customer</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;">${customerName}</td></tr>
        <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Email</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;">${email}</td></tr>
        <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Service</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;">${getServiceName(service)}</td></tr>
        <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Amount</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;">$${(amount / 100).toFixed(2)}</td></tr>
        <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Upload</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;"><a href="${uploadUrl}">${uploadUrl ? 'View File' : 'No file uploaded'}</a></td></tr>
        ${message ? `<tr><td style="padding: 8px;"><strong>Message</strong></td><td style="padding: 8px;">${message}</td></tr>` : ''}
      </table>
    </div>
  `;
}
