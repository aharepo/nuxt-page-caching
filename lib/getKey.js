function getKey({ appendHost, req, key }) {
  const host = req && req.headers ? req.headers.host : "";

  return appendHost ? `${key}-${host}` : key;
}

module.exports = getKey;
module.exports.default = getKey;
