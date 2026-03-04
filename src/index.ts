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
		body { background: #131722; padding: 24px; display: grid; gap: 28px; justify-content: center; }
		tv-mini-chart { display: block; width: 1100px; height: 360px; }
	</style>
</head>
<body>
	<tv-mini-chart symbol="BINANCE:BTCUSDT" show-time-range line-chart-type="Line" width="1100" height="360"></tv-mini-chart>
	<tv-mini-chart symbol="BINANCE:SOLUSDT" show-time-range line-chart-type="Line" width="1100" height="360"></tv-mini-chart>
	<tv-mini-chart symbol="WEEX:V2EXUSDT" show-time-range line-chart-type="Line" width="1100" height="360"></tv-mini-chart>
</body>
</html>`;

/** 缓存键（固定 URL，与请求方法无关） */
const CACHE_KEY = "https://worker.internal/v2ex-price-screenshot";

/**
 * Durable Object：作为单例串行化所有浏览器截图请求。
 * CF Browser Rendering 有并发会话数量限制（免费计划 2 个），
 * 多个并发请求同时调用 puppeteer.launch 会触发 429。
 * 通过 DO 将请求排队，确保同一时刻只有一个浏览器会话在运行。
 */
export class ScreenshotDO implements DurableObject {
	constructor(private state: DurableObjectState, private env: Env) {}

	async fetch(_request: Request): Promise<Response> {
		const browser = await puppeteer.launch(this.env.MYBROWSER);
		try {
			const page = await browser.newPage();
			await page.setViewport({ width: 1240, height: 1400 });
			await page.setContent(HTML_CONTENT, { waitUntil: "domcontentloaded", timeout: 15000 });
			// 等待图表组件渲染完成
			await new Promise((resolve) => setTimeout(resolve, 5000));
			const screenshot = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 1240, height: 1400 } });
			return new Response(screenshot, {
				status: 200,
				headers: { "Content-Type": "image/png" },
			});
		} finally {
			await browser.close();
		}
	}
}

/**
 * Worker 入口：检查缓存，缓存未命中时将截图任务转发给 DO 单例。
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

			// --- 2. 转发给 DO 单例执行截图（自动排队，避免并发 429）---
			const doId = env.SCREENSHOT_DO.idFromName("singleton");
			const stub = env.SCREENSHOT_DO.get(doId);
			const doResponse = await stub.fetch("https://do.internal/screenshot");

			if (!doResponse.ok) {
				const text = await doResponse.text();
				return new Response(`Screenshot failed: ${text}`, { status: doResponse.status });
			}

			const screenshot = await doResponse.arrayBuffer();

			// --- 3. 存入缓存 ---
			const cacheResponse = new Response(screenshot, {
				status: 200,
				headers: {
					"Content-Type": "image/png",
					"Cache-Control": "public, max-age=1800",
				},
			});
			ctx.waitUntil(cache.put(cacheRequest, cacheResponse.clone()));

			return new Response(screenshot, {
				status: 200,
				headers: {
					"Content-Type": "image/png",
					"Cache-Control": "no-store",
					"X-Cache": "MISS",
				},
			});
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			return new Response(`Screenshot failed: ${message}`, { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;
