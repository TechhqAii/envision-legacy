import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PRODUCTS = {
  animate: {
    name: 'Photo Animation',
    description: 'Transform your still photo into a living, breathing 5-second video',
    price: 2900, // $29.00
    mode: 'payment'
  },
  voice: {
    name: 'Voice Clone',
    description: 'Recreate their voice from a recording — hear them speak again',
    price: 4900, // $49.00
    mode: 'payment'
  },
  avatar: {
    name: 'AI Avatar',
    description: 'Build an interactive AI avatar from photos and memories',
    price: 9900, // $99.00
    mode: 'payment'
  },
  bundle: {
    name: 'Full Legacy Bundle',
    description: 'Animation + Voice Clone + Avatar — the complete memory experience',
    price: 14900, // $149.00
    mode: 'payment'
  }
};

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { service, customerName, customerEmail, uploadUrl, message, photoUrl, voiceSampleUrl } = req.body;

    if (!service || !PRODUCTS[service]) {
      return res.status(400).json({ error: 'Invalid service selected' });
    }

    if (!customerEmail) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const product = PRODUCTS[service];
    const origin = req.headers.origin || req.headers.referer?.replace(/\/[^/]*$/, '') || 'https://envision-legacy.vercel.app';

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: customerEmail,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: product.name,
              description: product.description,
            },
            unit_amount: product.price,
          },
          quantity: 1
        }
      ],
      mode: product.mode,
      success_url: `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/order.html?cancelled=true`,
      metadata: {
        service,
        customerName: customerName || '',
        uploadUrl: uploadUrl || '',
        message: message || '',
        photoUrl: photoUrl || '',
        voiceSampleUrl: voiceSampleUrl || '',
      }
    });

    return res.status(200).json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('Stripe checkout error:', err);
    return res.status(500).json({ error: 'Failed to create checkout session' });
  }
}
