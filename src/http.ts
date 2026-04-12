/**
 * Shared axios instance with optional HTTPS proxy support.
 *
 * If HTTPS_PROXY (or https_proxy) is set in the environment, all outbound
 * requests will be routed through that proxy. This is needed when Polymarket
 * is geo-blocked and you're running through a VPN or SOCKS/HTTP proxy.
 *
 * Usage in .env:
 *   HTTPS_PROXY=http://127.0.0.1:7890
 */

import axios from "axios";

const proxyUrl =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY  ||
  process.env.http_proxy;

if (proxyUrl) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = require("https-proxy-agent") as any;
  const agent = new mod.HttpsProxyAgent(proxyUrl);
  axios.defaults.httpsAgent = agent;
  axios.defaults.httpAgent  = agent;
  // Disable axios's own proxy handling so the agent takes full control
  (axios.defaults as any).proxy = false;
  console.info(`[http] Routing all requests via proxy: ${proxyUrl}`);
}

export default axios;
