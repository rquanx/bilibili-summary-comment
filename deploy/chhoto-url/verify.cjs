// Run with node --import tsx inside the prepared GPU image/container.
// Creates disposable test data only. Errors and logs never include URLs or keys.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

let stage = 'configuration';
async function main() {
  const base = 'https://s.voxwing.top';
  const physical = process.env.CHHOTO_CHECK_URL || base;
  const pb = process.env.PRIVATEBIN_URL || 'https://pastebin.tool.voxwing.top/';
  const key = process.env.KUTT_API_KEY;
  assert(key);
  process.env.KUTT_URL = base + '/';
  process.env.SHORT_LINK_PROVIDER = 'chhoto';
  const headers = { 'Content-Type': 'application/json', 'X-API-Key': key };
  const pbHeaders = { 'Content-Type': 'application/json', 'X-Requested-With': 'JSONHttpRequest' };
  const routedFetch = (url, options) => fetch(String(url).replace(base, physical), options);
  const { shortenSummaryUrl } = await import('/app/src/domains/bili/short-link.ts');
  let paste;
  let slug;
  try {
    stage = 'privatebin-encryption';
    const secret = crypto.randomBytes(32);
    const salt = crypto.randomBytes(8);
    const iv = crypto.randomBytes(16);
    const adata = [[iv.toString('base64'), salt.toString('base64'), 100000, 256, 128, 'aes', 'gcm', 'none'], 'plaintext', 0, 0];
    const derived = crypto.pbkdf2Sync(secret, salt, 100000, 32, 'sha256');
    const text = 'Chhoto migration acceptance ' + crypto.randomBytes(8).toString('hex');
    const cipher = crypto.createCipheriv('aes-256-gcm', derived, iv);
    cipher.setAAD(Buffer.from(JSON.stringify(adata)));
    const ct = Buffer.concat([cipher.update(JSON.stringify({ paste: text })), cipher.final(), cipher.getAuthTag()]).toString('base64');
    paste = await (await fetch(pb, { method: 'POST', headers: pbHeaders, body: JSON.stringify({ v: 2, adata, ct, meta: { expire: '5min' } }) })).json();
    assert(paste.status === 0);
    const stored = await (await fetch(pb + '?' + paste.id, { headers: pbHeaders })).json();
    const data = Buffer.from(stored.ct, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', derived, iv);
    decipher.setAAD(Buffer.from(JSON.stringify(stored.adata)));
    decipher.setAuthTag(data.subarray(-16));
    assert(JSON.parse(Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]).toString()).paste === text);
    // Base58 preserves leading zero bytes, as required by PrivateBin's key parser.
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let value = BigInt('0x' + secret.toString('hex'));
    let encoded = '';
    while (value) { encoded = alphabet[Number(value % 58n)] + encoded; value /= 58n; }
    for (const byte of secret) { if (byte !== 0) break; encoded = '1' + encoded; }
    const target = pb + '?' + paste.id + '#' + encoded + '&view=reader';
    slug = crypto.createHash('sha256').update(target).digest('hex').slice(0, 10);
    console.log('PASS PrivateBin encrypted create/read/decrypt');

    stage = 'pipeline-shortening';
    const short = await shortenSummaryUrl(target, routedFetch);
    assert(short === base + '/' + slug);
    assert(await shortenSummaryUrl(target, routedFetch) === short);
    const redirect = await fetch(physical + '/' + slug, { redirect: 'manual' });
    assert(redirect.status === 307 && redirect.headers.get('location') === target);
    console.log('PASS real pipeline API/create/reuse/redirect/key preservation');

    stage = 'access-control';
    const body = JSON.stringify({ longlink: target });
    const anonymous = await fetch(physical + '/api/new', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert(anonymous.status === 401);
    const bad = await fetch(physical + '/api/all', { headers: { 'X-API-Key': 'invalid-acceptance-key' } });
    assert(bad.status === 401);
    if (process.env.CHHOTO_TEST_PASSWORD) {
      const login = await fetch(physical + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: process.env.CHHOTO_TEST_PASSWORD, remember: false }) });
      assert(login.ok && (await login.json()).success === true);
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const managed = await fetch(physical + '/api/all', { headers: { Cookie: cookie } });
      assert(managed.ok && Array.isArray(await managed.json()));
    }
    console.log('PASS anonymous rejection/API authentication/admin password login');
  } finally {
    const failedAt = stage;
    stage = 'acceptance-cleanup';
    try {
      if (slug) {
        const deleted = await fetch(physical + '/api/del/' + slug, { method: 'DELETE', headers });
        assert(deleted.ok || deleted.status === 400);
        const missing = await fetch(physical + '/' + slug, { redirect: 'manual' });
        assert(missing.status === 404);
      }
    } finally {
      if (paste?.id && paste?.deletetoken) {
        const deleted = await (await fetch(pb + '?pasteid=' + paste.id + '&deletetoken=' + paste.deletetoken, { headers: pbHeaders })).json();
        assert(deleted.status === 0);
      }
    }
    console.log('PASS acceptance data cleanup');
    stage = failedAt;
  }
}
main().catch(() => { console.error('FAIL acceptance stage: ' + stage); process.exitCode = 1; });
