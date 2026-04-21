// Preview proxy: fetches the Laravel project and rewrites absolute URLs in the HTML
// back to /preview/..., so navigation inside the iframe stays same-origin.
// Also injects a small script that postMessages the current URL to the parent window
// on every navigation, so the platform always knows which page the user is on.
//
// Target URL: taken from the `preview_target` cookie (set by the parent page when
// it loads a project), with a sensible dev fallback. Generic across projects.

export const dynamic = 'force-dynamic';

async function handle(request, { params }) {
  const { slug } = await params;
  const subPath = Array.isArray(slug) ? slug.join('/') : '';
  const incoming = new URL(request.url);

  const cookieHeader = request.headers.get('cookie') || '';
  const targetMatch = cookieHeader.match(/(?:^|;\s*)preview_target=([^;]+)/);
  const target = targetMatch ? decodeURIComponent(targetMatch[1]) : 'http://localhost:8100';
  const targetOrigin = target.replace(/\/+$/, '');

  const upstreamUrl = `${targetOrigin}/${subPath}${incoming.search}`;

  const forwardHeaders = new Headers();
  for (const [k, v] of request.headers) {
    if (['host', 'connection', 'content-length'].includes(k.toLowerCase())) continue;
    forwardHeaders.set(k, v);
  }
  forwardHeaders.set('Accept-Encoding', 'identity');

  let upstreamResp;
  try {
    upstreamResp = await fetch(upstreamUrl, {
      method: request.method,
      headers: forwardHeaders,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
      redirect: 'manual'
    });
  } catch (e) {
    return new Response(`Preview proxy error: ${e.message}\nTarget: ${upstreamUrl}`, { status: 502 });
  }

  // Pass redirects through after rewriting the Location header
  if (upstreamResp.status >= 300 && upstreamResp.status < 400 && upstreamResp.headers.get('location')) {
    const loc = upstreamResp.headers.get('location');
    const rewritten = loc.startsWith(targetOrigin) ? '/preview' + loc.slice(targetOrigin.length) : loc;
    const hdrs = new Headers(upstreamResp.headers);
    hdrs.set('location', rewritten);
    return new Response(null, { status: upstreamResp.status, headers: hdrs });
  }

  const contentType = upstreamResp.headers.get('content-type') || '';

  // HTML: rewrite absolute project URLs and inject the URL beacon
  if (contentType.includes('text/html')) {
    let html = await upstreamResp.text();

    const escaped = targetOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(new RegExp(escaped, 'g'), '/preview');

    const beacon = `
<script>(function(){
  function report(){ try { window.parent.postMessage({ type: 'iframe-navigation', url: location.href }, '*'); } catch(e){} }
  report();
  var _push = history.pushState, _replace = history.replaceState;
  history.pushState = function(){ _push.apply(this, arguments); setTimeout(report, 0); };
  history.replaceState = function(){ _replace.apply(this, arguments); setTimeout(report, 0); };
  window.addEventListener('popstate', report);
  window.addEventListener('hashchange', report);
})();</script>`;

    if (/<head(\s[^>]*)?>/i.test(html)) html = html.replace(/<head(\s[^>]*)?>/i, m => m + beacon);
    else html = beacon + html;

    const hdrs = new Headers();
    hdrs.set('content-type', 'text/html; charset=utf-8');
    const setCookie = upstreamResp.headers.get('set-cookie');
    if (setCookie) hdrs.set('set-cookie', setCookie);
    return new Response(html, { status: upstreamResp.status, headers: hdrs });
  }

  // Non-HTML: pass through
  const passHeaders = new Headers();
  for (const [k, v] of upstreamResp.headers) {
    if (['content-encoding', 'transfer-encoding'].includes(k.toLowerCase())) continue;
    passHeaders.set(k, v);
  }
  return new Response(upstreamResp.body, { status: upstreamResp.status, headers: passHeaders });
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
