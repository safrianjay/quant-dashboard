/**
 * Netlify Function: send-email
 * Sends payment confirmation email via Gmail SMTP using nodemailer.
 * Requires environment variables: GMAIL_USER, GMAIL_PASS
 */
const nodemailer = require('nodemailer');

exports.handler = async (event) => {
  /* Only allow POST */
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (_) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { email, planName, amount, uid } = body;

  if (!email || !planName) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing email or planName' }) };
  }

  /* Gmail transporter */
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_PASS
    }
  });

  const mailOptions = {
    from: `"Quantichy" <${process.env.GMAIL_USER}>`,
    to: email,
    subject: `✅ Payment Confirmed — Welcome to ${planName}!`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin:0;padding:0;background:#F1F5F9;font-family:'Inter',Arial,sans-serif">
        <div style="max-width:560px;margin:40px auto;background:white;border-radius:16px;overflow:hidden;border:1px solid #E2E8F0;box-shadow:0 4px 24px rgba(0,0,0,.07)">

          <!-- Header -->
          <div style="background:#0F172A;padding:32px 36px;text-align:center">
            <div style="display:inline-flex;align-items:center;gap:10px">
              <svg width="32" height="32" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
                <defs>
                  <linearGradient id="g1" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#ffffff" stop-opacity=".3"/></linearGradient>
                  <linearGradient id="g2" x1="1" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#ffffff" stop-opacity=".3"/></linearGradient>
                </defs>
                <polygon points="75,20 85,20 85,30" fill="white"/>
                <polygon points="25,80 15,80 15,70" fill="white"/>
                <path d="M60,30 L45,30 C35,30 25,40 25,50 L50,75" stroke="url(#g2)" stroke-width="15" fill="none"/>
                <path d="M40,70 L55,70 C65,70 75,60 75,50 L50,25" stroke="url(#g1)" stroke-width="15" fill="none"/>
              </svg>
              <span style="color:white;font-size:22px;font-weight:800;letter-spacing:-.02em">Quantichy</span>
            </div>
          </div>

          <!-- Success badge -->
          <div style="text-align:center;padding:32px 36px 0">
            <div style="display:inline-flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:50%;background:#D1FAE5;margin-bottom:16px">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#10B981" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            <h1 style="font-size:22px;font-weight:800;color:#0F172A;margin:0 0 8px;letter-spacing:-.02em">Payment Confirmed!</h1>
            <p style="font-size:15px;color:#64748B;margin:0;line-height:1.5">Your <strong style="color:#0F172A">${planName} Plan</strong> is now active.</p>
          </div>

          <!-- Details card -->
          <div style="margin:24px 36px;background:#F8FAFC;border-radius:12px;border:1px solid #E2E8F0;padding:20px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
              <span style="font-size:13px;color:#64748B;font-weight:500">Plan</span>
              <span style="font-size:13px;color:#0F172A;font-weight:700">${planName}</span>
            </div>
            <div style="height:1px;background:#E2E8F0;margin-bottom:12px"></div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
              <span style="font-size:13px;color:#64748B;font-weight:500">Amount Paid</span>
              <span style="font-size:13px;color:#0F172A;font-weight:700">$${amount} USDT</span>
            </div>
            <div style="height:1px;background:#E2E8F0;margin-bottom:12px"></div>
            <div style="display:flex;justify-content:space-between;align-items:center">
              <span style="font-size:13px;color:#64748B;font-weight:500">Status</span>
              <span style="font-size:12px;font-weight:700;color:#15803D;background:#F0FDF4;padding:3px 10px;border-radius:100px;border:1px solid #BBF7D0">✓ Approved</span>
            </div>
          </div>

          <!-- CTA -->
          <div style="padding:0 36px 32px;text-align:center">
            <a href="https://quantichy.com/app" style="display:inline-block;background:#001f5c;color:white;font-size:14px;font-weight:700;padding:14px 32px;border-radius:10px;text-decoration:none;letter-spacing:.01em">
              Open Dashboard →
            </a>
            <p style="font-size:12px;color:#94A3B8;margin:20px 0 0;line-height:1.6">
              Questions? Reply to this email or contact us at<br>
              <a href="mailto:support@quantichy.com" style="color:#001f5c;font-weight:600">support@quantichy.com</a>
            </p>
          </div>

          <!-- Footer -->
          <div style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:16px 36px;text-align:center">
            <p style="font-size:11px;color:#94A3B8;margin:0">© ${new Date().getFullYear()} Quantichy. All rights reserved.</p>
          </div>

        </div>
      </body>
      </html>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log('[send-email] Email sent to:', email);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ success: true })
    };
  } catch (err) {
    console.error('[send-email] Error:', err.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
