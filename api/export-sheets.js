const crypto = require('crypto');

function b64url(data) {
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  return Buffer.from(str).toString('base64url');
}

async function getGoogleToken(email, privateKey) {
  const now     = Math.floor(Date.now() / 1000);
  const header  = b64url({ alg: 'RS256', typ: 'JWT' });
  const payload = b64url({
    iss:   email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  });
  const unsigned = `${header}.${payload}`;
  const sig      = crypto.createSign('RSA-SHA256').update(unsigned).sign(privateKey, 'base64url');
  const jwt      = `${unsigned}.${sig}`;

  const res  = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion:  jwt,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Token error: ${JSON.stringify(data)}`);
  return data.access_token;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const email      = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const sheetId    = process.env.GOOGLE_SPREADSHEET_ID;

  if (!email || !privateKey || !sheetId) {
    return res.status(500).json({ error: 'Missing environment variables' });
  }

  try {
    const token = await getGoogleToken(email, privateKey);

    // Fetch walkin/staying entries from Supabase
    const sbRes = await fetch(
      'https://xbtxluhvyuobcdipsjhe.supabase.co/rest/v1/entries' +
      '?type=in.(walkin,staying)&order=ts.asc&select=*',
      {
        headers: {
          apikey:        'sb_publishable_gFHEUXtGlz2-8TNcteJKgQ_ogSRWBdz',
          Authorization: 'Bearer sb_publishable_gFHEUXtGlz2-8TNcteJKgQ_ogSRWBdz',
        },
      }
    );
    const entries = await sbRes.json();
    if (!Array.isArray(entries)) throw new Error(`Supabase error: ${JSON.stringify(entries)}`);

    // Get first sheet name
    const infoRes  = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const info = await infoRes.json();
    if (!info.sheets) throw new Error(`Sheets info error: ${JSON.stringify(info)}`);
    const sheetName    = info.sheets[0].properties.title;
    const encodedRange = encodeURIComponent(`${sheetName}!A:F`);

    // Clear existing data
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodedRange}:clear`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } }
    );

    // Write header + data
    const values = [
      ['Date', 'Time', 'Type', 'Room', 'Guests'],
      ...entries.map(e => [
        e.date  || '',
        e.time  || '',
        e.type === 'walkin' ? 'Walk-in' : 'Hotel Guest',
        e.room  || '-',
        e.count,
      ]),
    ];

    const writeRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(sheetName + '!A1')}?valueInputOption=RAW`,
      {
        method:  'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ values }),
      }
    );
    const writeData = await writeRes.json();
    if (writeData.error) throw new Error(`Write error: ${JSON.stringify(writeData.error)}`);

    return res.status(200).json({ ok: true, rows: entries.length });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
