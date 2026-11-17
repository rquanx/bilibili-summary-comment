// Run inside Kutt's container with KUTT_API_KEY provided through its environment.
// Only creates disposable acceptance data; never prints targets or secret keys.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

async function main() {
  const apiHeaders = { 'Content-Type': 'application/json', 'X-API-Key': process.env.KUTT_API_KEY };
  assert(apiHeaders['X-API-Key'], 'KUTT_API_KEY required');
  const pb = process.env.PRIVATEBIN_CHECK_URL || 'http://privatebin:8080/';
  const kutt = process.env.KUTT_CHECK_URL || 'http://kutt:3000';
  const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'JSONHttpRequest' };
  const secret = crypto.randomBytes(32);
  const salt = crypto.randomBytes(8);
  const iv = crypto.randomBytes(16);
  const adata = [[iv.toString('base64'), salt.toString('base64'), 100000, 256, 128, 'aes', 'gcm', 'none'], 'plaintext', 0, 0];
  const key = crypto.pbkdf2Sync(secret, salt, 100000, 32, 'sha256');
  const text = '阿里云迁移验收：PrivateBin 加密与 Kutt 短链。';
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(adata)));
  const ct = Buffer.concat([cipher.update(JSON.stringify({ paste: text })), cipher.final(), cipher.getAuthTag()]).toString('base64');
  let paste;
  let link;
  try {
    const response = await fetch(pb, { method: 'POST', headers, body: JSON.stringify({ v: 2, adata, ct, meta: { expire: '5min' } }) });
    paste = await response.json();
    assert.equal(paste.status, 0, 'paste creation');
    const stored = await (await fetch(pb + '?' + paste.id, { headers })).json();
    const data = Buffer.from(stored.ct, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(JSON.stringify(stored.adata)));
    decipher.setAuthTag(data.subarray(-16));
    assert.equal(JSON.parse(Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]).toString()).paste, text);
    console.log('PASS PrivateBin encrypted create/read/decrypt');

    const target = 'https://privatebin.tool.voxwing.top/?' + paste.id + '#migration-test&view=reader';
    const result = await fetch(kutt + '/api/v2/links', { method: 'POST', headers: apiHeaders, body: JSON.stringify({ target, customurl: 'migration' + crypto.randomBytes(4).toString('hex') }) });
    assert.equal(result.status, 201, 'short link creation');
    link = await result.json();
    const redirect = await fetch(kutt + new URL(link.link).pathname, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), target);
    const anonymous = await fetch(kutt + '/api/v2/links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target }) });
    assert(anonymous.status >= 400, 'anonymous creation rejected');
    console.log('PASS Kutt migrated API key/create/redirect/anonymous restriction');
  } finally {
    if (link?.id) {
      const response = await fetch(kutt + '/api/v2/links/' + link.id, { method: 'DELETE', headers: apiHeaders });
      assert(response.ok, 'test short link cleanup');
    }
    if (paste?.id && paste?.deletetoken) {
      const result = await (await fetch(pb + '?pasteid=' + paste.id + '&deletetoken=' + paste.deletetoken, { headers })).json();
      assert.equal(result.status, 0, 'test paste cleanup');
    }
    console.log('PASS acceptance data cleanup');
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
