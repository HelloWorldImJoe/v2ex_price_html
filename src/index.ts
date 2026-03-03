import puppeteer from "@cloudflare/puppeteer";

/** 要截图的 HTML 页面内容 */
const HTML_CONTENT = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script type="module" src="https://widgets.tradingview-widget.com/w/zh_CN/tv-mini-chart.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #131722; }
    tv-mini-chart { display: block; width: 800px; height: 300px; }
  </style>
</head>
<body>
  <tv-mini-chart symbol="WEEX:V2EXUSDT" show-time-range width="800" height="300"></tv-mini-chart>
</body>
</html>`;

/** 缓存键（固定 URL，与请求方法无关） */
const CACHE_KEY = "https://worker.internal/v2ex-price-screenshot";

/**
 * 使用 Cloudflare Browser Rendering 对 index.html 截图，
 * 并通过 Cache API 缓存 60 秒。
 */
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		try {
			const url = new URL(request.url);

			// 仅处理 GET /  和  GET /screenshot
			if (request.method !== "GET" || (url.pathname !== "/" && url.pathname !== "/screenshot")) {
				return new Response("Not Found", { status: 404 });
			}

			// --- 1. 检查缓存 ---
			const cache = caches.default;
			const cacheRequest = new Request(CACHE_KEY);
			const cached = await cache.match(cacheRequest);
			if (cached) {
				const res = new Response(cached.body, cached);
				res.headers.set("X-Cache", "HIT");
				res.headers.set("Cache-Control", "no-store");
				return res;
			}

			// --- 2. 启动浏览器截图 ---
			const browser = await puppeteer.launch(env.MYBROWSER);
			try {
				const page = await browser.newPage();
				await page.setViewport({ width: 800, height: 300 });
				// 使用 domcontentloaded：DOM 解析完即继续，避免等待 TradingView
				// 模块的级联请求和 WebSocket 连接导致 load 事件迟迟不触发而超时
				await page.setContent(HTML_CONTENT, { waitUntil: "domcontentloaded", timeout: 15000 });
				// 等待图表组件渲染完成
				await new Promise((resolve) => setTimeout(resolve, 5000));
				const screenshot = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 800, height: 300 } });

				// 存入 Cache API 的副本：保留 max-age=300 让 Cloudflare 知道 TTL
				const cacheResponse = new Response(screenshot, {
					status: 200,
					headers: {
						"Content-Type": "image/png",
						"Cache-Control": "public, max-age=300",
					},
				});

				// --- 3. 存入缓存（使用 waitUntil 避免阻塞响应） ---
				ctx.waitUntil(cache.put(cacheRequest, cacheResponse.clone()));

				// 返回给浏览器的副本：禁止浏览器本地缓存，确保每次都拿到最新图片
				return new Response(screenshot, {
					status: 200,
					headers: {
						"Content-Type": "image/png",
						"Cache-Control": "no-store",
						"X-Cache": "MISS",
					},
				});
			} finally {
				await browser.close();
			}
		} catch (err: unknown) {
			// 捕获所有异常（包括 puppeteer TimeoutError 等），
			// 返回 500 而不是让 Worker 抛出未捕获异常导致 CF Error 1101
			const message = err instanceof Error ? err.message : String(err);
			return new Response(`Screenshot failed: ${message}`, { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;
