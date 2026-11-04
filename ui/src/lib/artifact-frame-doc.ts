/**
 * The document an html artifact runs as: its HTML with, first in the page, a Content Security Policy
 * (no network but a few CDNs for scripts, styles and fonts; data only through the bridge) and the
 * `polpo` bridge, which asks the dashboard for data over postMessage. The iframe is sandboxed without
 * same-origin, so the page cannot read the dashboard, its cookies or its storage.
 */

export const ARTIFACT_CHANNEL = "polpo:artifact";

const CDNS = "https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com";

export const ARTIFACT_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' ${CDNS}`,
  `style-src 'unsafe-inline' https://fonts.googleapis.com ${CDNS}`,
  `font-src data: https://fonts.gstatic.com ${CDNS}`,
  "img-src data: blob: https:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** The bridge, as a script: `polpo.sources/describe/query/sql`, `onRefresh`, `theme`/`onTheme`. */
export function bridgeScript(theme: "light" | "dark"): string {
  return `(function(){
var CH=${JSON.stringify(ARTIFACT_CHANNEL)},pending={},n=0,refresh=[],themes=[];
function call(method,params){return new Promise(function(resolve,reject){var id=++n;pending[id]={resolve:resolve,reject:reject};parent.postMessage({channel:CH,type:"call",id:id,method:method,params:params||{}},"*");});}
window.addEventListener("message",function(e){if(e.source!==parent)return;var m=e.data;if(!m||m.channel!==CH)return;
if(m.type==="result"){var p=pending[m.id];if(!p)return;delete pending[m.id];if(m.ok)p.resolve(m.data);else p.reject(new Error(m.error||"Data request failed"));}
else if(m.type==="refresh"){refresh.forEach(function(f){try{f();}catch(err){console.error(err);}});}
else if(m.type==="theme"){window.polpo.theme=m.theme;document.documentElement.setAttribute("data-theme",m.theme);themes.forEach(function(f){try{f(m.theme);}catch(err){console.error(err);}});}});
function ready(f){if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",function(){f();});else setTimeout(f,0);}
window.polpo={theme:${JSON.stringify(theme)},
sources:function(){return call("sources");},
describe:function(sourceId){return call("describe",{sourceId:sourceId});},
query:function(q){return call("query",q);},
sql:function(sourceId,sql){return call("sql",{sourceId:sourceId,sql:sql});},
onRefresh:function(f){refresh.push(f);ready(f);},
onTheme:function(f){themes.push(f);}};
document.documentElement.setAttribute("data-theme",${JSON.stringify(theme)});
})();`;
}

/**
 * The artifact's HTML with the policy and the bridge first: right after the doctype when there is one
 * (the parser puts them in the head), otherwise at the very start, so nothing of the page runs before.
 */
export function artifactFrameDoc(html: string, theme: "light" | "dark"): string {
  const head = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}"><meta name="color-scheme" content="light dark"><script>${bridgeScript(theme)}</script>`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return `${doctype[0]}${head}${html.slice(doctype[0].length)}`;
  return `<!doctype html>${head}${html}`;
}
