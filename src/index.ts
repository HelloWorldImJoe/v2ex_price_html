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
	<tv-mini-chart symbol="BINANCE:BTCUSDT" show-time-range width="1100" height="360"></tv-mini-chart>
	<tv-mini-chart symbol="BINANCE:SOLUSDT" show-time-range width="1100" height="360"></tv-mini-chart>
	<tv-mini-chart symbol="WEEX:V2EXUSDT" show-time-range width="1100" height="360"></tv-mini-chart>
	<tv-mini-chart symbol="WEEX:V2EXUSDT" show-time-range time-frame="7D" width="1100" height="360"></tv-mini-chart>
	<tv-mini-chart symbol="WEEX:V2EXUSDT" show-time-range time-frame="1M" width="1100" height="360"></tv-mini-chart>
</body>
</html>`;

/** 缓存键（固定 URL，与请求方法无关） */
const CACHE_KEY = "https://worker.internal/v2ex-price-screenshot";

/**
 * Durable Object：单例去重所有浏览器截图请求。
 * CF Browser Rendering 有并发会话数量限制（免费计划 2 个），
 * 多个并发请求同时调用 puppeteer.launch 会触发 429。
 * 通过 DO 单例 + Promise 复用，确保同一时刻只启动一个浏览器会话：
 * 若截图正在进行中，后续请求直接 await 同一个 Promise，
 * 截图完成后所有等待者共享同一结果，无需重复渲染。
 */
export class ScreenshotDO implements DurableObject {
	/** 正在进行中的截图 Promise，为 null 表示当前空闲 */
	private activeScreenshot: Promise<Uint8Array> | null = null;

	constructor(private state: DurableObjectState, private env: Env) {}

	async fetch(_request: Request): Promise<Response> {
		// 若已有截图任务在执行，复用同一 Promise，避免启动多个浏览器会话
		if (!this.activeScreenshot) {
			this.activeScreenshot = this.takeScreenshot().finally(() => {
				this.activeScreenshot = null;
			});
		}

		const screenshot = await this.activeScreenshot;
		return new Response(screenshot, {
			status: 200,
			headers: { "Content-Type": "image/png" },
		});
	}

	private async takeScreenshot(): Promise<Uint8Array> {
		const browser = await puppeteer.launch(this.env.MYBROWSER);
		try {
			const page = await browser.newPage();
			await page.setViewport({ width: 1240, height: 2000 });
			await page.setContent(HTML_CONTENT, { waitUntil: "domcontentloaded", timeout: 15000 });
			// 等待图表组件渲染完成
			await new Promise((resolve) => setTimeout(resolve, 5000));
			return await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 1240, height: 2000 } });
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
					"Cache-Control": "public, max-age=3600", // 1 小时
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
