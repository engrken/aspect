export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb'
    }
  }
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }

  const action = req.body?.action;

  // Route Vision grading internally to bypass Apps Script 30s timeouts
  if (action === 'AI_VISION_GRADE') {
    const visionGradeHandler = (await import('./vision-grade.js')).default;
    return visionGradeHandler(req, res);
  }

  // Proxy all other database/roster requests to Google Apps Script
  const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_BACKEND_URL;
  
  if (!APPS_SCRIPT_URL) {
    return res.status(500).json({ success: false, message: 'Server configuration error: Missing APPS_SCRIPT_BACKEND_URL environment variable.' });
  }

  try {
    const upstreamRes = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(req.body)
    });

    const data = await upstreamRes.json();
    return res.status(200).json(data);
  } catch (err) {
    return res.status(502).json({ success: false, message: `Upstream gateway error: ${err.message}` });
  }
}