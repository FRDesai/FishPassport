// the adress 

function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  const host = req.get('x-forwarded-host') || req.get('x-original-host') || req.get('host');
  const proto = req.get('x-forwarded-proto') || req.protocol;
  return `${proto.split(',')[0].trim()}://${host.split(',')[0].trim()}`;
}
module.exports = { baseUrl };