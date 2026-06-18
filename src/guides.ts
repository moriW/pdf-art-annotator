/**
 * 构图辅助线渲染器
 *
 * 所有辅助线都画在一个像素坐标矩形 {x, y, w, h} 内。
 * 对外入口是 `drawGuide()`：调用方只需要选择辅助线类型，并传入页面区域
 * 的像素矩形。每种辅助线都会先转成通用绘图 primitive，再统一渲染到 canvas。
 *
 * 当前支持：
 *  - 9格网格（三分线）
 *  - 12格网格
 *  - 黄金螺旋
 *  - 黄金分割线
 *  - 对角十字（两条对角线 + 中心十字）
 */

export type GuideType =
	| "grid-9"
	| "grid-12"
	| "golden-spiral"
	| "golden-ratio"
	| "diagonals";
export type GuideRotation = 0 | 1 | 2 | 3;

export interface GuideState {
	type: GuideType;
	visible: boolean;
	/** 稳定唯一 id，用于同时管理多个辅助线实例 */
	_id?: string;
	/** 归一化到 0-1 的矩形；省略时表示覆盖整个画布 */
	rect?: { x: number; y: number; w: number; h: number };
	/** 顺时针旋转 0/90/180/270 度；黄金螺旋用它决定起笔方向 */
	rotation?: GuideRotation;
	strokeWidth?: number;
	color?: string;
	mirrorX?: boolean;
	mirrorY?: boolean;
}

const PHI = (1 + Math.sqrt(5)) / 2; // ≈ 1.618
const INV_PHI = 1 / PHI; // ≈ 0.618
const GOLDEN_SPIRAL_DEPTH = 18;

// 非螺旋辅助线都可以描述为一小组可绘制 primitive。
// 这样每种辅助线只关心自己的几何结构，颜色、虚线、透明度、线宽等 canvas 细节
// 统一交给渲染器处理。
type Point = { x: number; y: number };
type GuideLinePrimitive = {
	kind: "line";
	from: Point;
	to: Point;
	alpha?: number;
	dash?: number[];
	widthScale?: number;
};
type GuideDotPrimitive = {
	kind: "dot";
	center: Point;
	radius: number;
	alpha?: number;
};
type GuideCirclePrimitive = {
	kind: "circle";
	center: Point;
	radius: number;
	alpha?: number;
	dash?: number[];
	widthScale?: number;
};
type GuideArcPrimitive = {
	kind: "arc";
	center: Point;
	radius: number;
	startAngle: number;
	endAngle: number;
	alpha?: number;
	dash?: number[];
	widthScale?: number;
};
type GuidePrimitive = GuideLinePrimitive | GuideDotPrimitive | GuideCirclePrimitive | GuideArcPrimitive;

export function getGuideRenderRect(
	type: GuideType,
	x: number,
	y: number,
	w: number,
	h: number,
	rotation: GuideRotation = DEFAULT_SPIRAL_ROTATION,
) {
	return type === "golden-spiral" ? fitGoldenRect(x, y, w, h, isVerticalRotation(rotation) ? 1 / PHI : PHI) : { x, y, w, h };
}

/**
 * 在指定像素矩形内绘制一条辅助线。
 *
 * `rx/ry/rw/rh` 已经是页面空间里的像素值，不是批注数据里的归一化坐标。
 * overlay 层会先把归一化 guide rect 转成这些像素值，再调用这里。
 */
export function drawGuide(
	ctx: CanvasRenderingContext2D,
	type: GuideType,
	rx: number, ry: number, rw: number, rh: number,
	options?: { rotation?: GuideRotation; strokeWidth?: number; color?: string; mirrorX?: boolean; mirrorY?: boolean }
) {
	ctx.save();

	// 镜像作用在整套局部坐标系上。完成 transform 之后，后续绘制仍然可以像
	// 没有镜像一样从 (0, 0) 开始计算。
	if (options?.mirrorX || options?.mirrorY) {
		ctx.translate(rx + (options.mirrorX ? rw : 0), ry + (options.mirrorY ? rh : 0));
		ctx.scale(options.mirrorX ? -1 : 1, options.mirrorY ? -1 : 1);
		rx = 0;
		ry = 0;
	}
	const strokeWidth = Math.max(0.5, options?.strokeWidth ?? 1);
	const color = options?.color ?? "#ffffff";
	ctx.strokeStyle = guideColor(color, 0.72);
	ctx.lineWidth = strokeWidth;
	ctx.setLineDash([4, 4]);

	switch (type) {
		// 这些辅助线最终都可以归约成线、点、圆或圆弧，所以走同一套 primitive 渲染器。
		case "grid-9":
			drawGuidePrimitives(ctx, grid9Primitives(rx, ry, rw, rh), color, strokeWidth);
			break;
		case "grid-12":
			drawGuidePrimitives(ctx, gridPrimitives(rx, ry, rw, rh, 4, 3), color, strokeWidth);
			break;
		case "golden-spiral":
			drawGuidePrimitives(ctx, goldenSpiralPrimitives(rx, ry, rw, rh, options?.rotation), color, strokeWidth);
			break;
		case "golden-ratio":
			drawGuidePrimitives(ctx, goldenRatioPrimitives(rx, ry, rw, rh), color, strokeWidth);
			break;
		case "diagonals":
			drawGuidePrimitives(ctx, diagonalPrimitives(rx, ry, rw, rh), color, strokeWidth);
			break;
	}

	ctx.restore();
}

function guideColor(hex: string, alpha: number) {
	const normalized = hex.trim();
	const match = /^#?([0-9a-f]{6})$/i.exec(normalized);
	if (!match) return `rgba(255,255,255,${alpha})`;
	const value = match[1];
	const r = parseInt(value.slice(0, 2), 16);
	const g = parseInt(value.slice(2, 4), 16);
	const b = parseInt(value.slice(4, 6), 16);
	return `rgba(${r},${g},${b},${alpha})`;
}

// ─── primitive 辅助线渲染 ───

/**
 * 把 primitive 几何描述渲染到 canvas。
 *
 * primitive 刻意使用绝对像素坐标。这样各个 guide builder 可以先完成自己的几何
 * 计算，而这里只作为稳定、可预测的 canvas 适配层。
 */
function drawGuidePrimitives(
	ctx: CanvasRenderingContext2D,
	primitives: GuidePrimitive[],
	color: string,
	strokeWidth: number,
) {
	for (const primitive of primitives) {
		if (primitive.kind === "line") {
			ctx.strokeStyle = guideColor(color, primitive.alpha ?? 0.72);
			ctx.lineWidth = strokeWidth * (primitive.widthScale ?? 1);
			ctx.setLineDash(primitive.dash ?? [4, 4]);
			ctx.beginPath();
			ctx.moveTo(primitive.from.x, primitive.from.y);
			ctx.lineTo(primitive.to.x, primitive.to.y);
			ctx.stroke();
		} else if (primitive.kind === "dot") {
			ctx.fillStyle = guideColor(color, primitive.alpha ?? 0.9);
			ctx.beginPath();
			ctx.arc(primitive.center.x, primitive.center.y, primitive.radius, 0, Math.PI * 2);
			ctx.fill();
		} else if (primitive.kind === "circle") {
			ctx.strokeStyle = guideColor(color, primitive.alpha ?? 0.48);
			ctx.lineWidth = strokeWidth * (primitive.widthScale ?? 1);
			ctx.setLineDash(primitive.dash ?? [2, 4]);
			ctx.beginPath();
			ctx.arc(primitive.center.x, primitive.center.y, primitive.radius, 0, Math.PI * 2);
			ctx.stroke();
		} else {
			ctx.strokeStyle = guideColor(color, primitive.alpha ?? 0.88);
			ctx.lineWidth = strokeWidth * (primitive.widthScale ?? 1);
			ctx.setLineDash(primitive.dash ?? []);
			ctx.beginPath();
			ctx.arc(primitive.center.x, primitive.center.y, primitive.radius, primitive.startAngle, primitive.endAngle);
			ctx.stroke();
		}
	}
}

// ─── 9格网格 / 三分法 ───

// 9格就是经典三分法：两条竖线、两条横线，再突出四个交点。
function grid9Primitives(rx: number, ry: number, rw: number, rh: number): GuidePrimitive[] {
	const x1 = rx + rw / 3, x2 = rx + 2 * rw / 3;
	const y1 = ry + rh / 3, y2 = ry + 2 * rh / 3;
	return [
		...gridPrimitives(rx, ry, rw, rh, 3, 3),
		...dotPrimitives([[x1, y1], [x2, y1], [x1, y2], [x2, y2]], 3, 0.9),
	];
}

// ─── 12格网格 ───

// 通用网格构造器。`grid-9` 和 `grid-12` 都使用它，只是列数和行数不同。
function gridPrimitives(
	rx: number,
	ry: number,
	rw: number,
	rh: number,
	cols: number,
	rows: number,
): GuidePrimitive[] {
	const primitives: GuidePrimitive[] = [];
	for (let c = 1; c < cols; c++) {
		const x = rx + (rw * c) / cols;
		primitives.push(linePrimitive(x, ry, x, ry + rh));
	}
	for (let r = 1; r < rows; r++) {
		const y = ry + (rh * r) / rows;
		primitives.push(linePrimitive(rx, y, rx + rw, y));
	}
	return primitives;
}

// 便捷构造器：让各个辅助线定义更短，也更容易扫读。
function linePrimitive(
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	options: Omit<GuideLinePrimitive, "kind" | "from" | "to"> = {},
): GuideLinePrimitive {
	return { kind: "line", from: { x: x1, y: y1 }, to: { x: x2, y: y2 }, ...options };
}

function dotPrimitives(dots: number[][], radius: number, alpha: number): GuideDotPrimitive[] {
	return dots.map(([x, y]) => ({ kind: "dot", center: { x, y }, radius, alpha }));
}

// ─── 黄金螺旋 ───
// 基于黄金矩形不断切分出的四分之一圆弧，从外缘向中心形成平滑螺旋。
// `rotation` 表示标准螺旋顺时针旋转了几个 90 度，不再把方向绑定到角落名称。
const DEFAULT_SPIRAL_ROTATION: GuideRotation = 1;

function goldenSpiralPrimitives(
	rx: number,
	ry: number,
	rw: number,
	rh: number,
	rotation: GuideRotation = DEFAULT_SPIRAL_ROTATION,
): GuidePrimitive[] {
	const fitted = getGuideRenderRect("golden-spiral", rx, ry, rw, rh, rotation);
	const angle = rotation * Math.PI / 2;
	const localW = isVerticalRotation(rotation) ? fitted.h : fitted.w;
	const localH = isVerticalRotation(rotation) ? fitted.w : fitted.h;
	const cx = fitted.x + fitted.w / 2;
	const cy = fitted.y + fitted.h / 2;
	const toPage = (point: Point) => rotatePoint(point, angle, { x: cx, y: cy });

	return [
		...goldenRatioLinePrimitives(-localW / 2, -localH / 2, localW, localH, 0.26, [2, 4]).map((primitive) =>
			transformLinePrimitive(primitive, toPage)
		),
		...goldenSpiralBasePrimitives(-localW / 2, -localH / 2, localW, localH, GOLDEN_SPIRAL_DEPTH).map((primitive) =>
			transformPrimitive(primitive, toPage, angle)
		),
	];
}

// 在用户选出的 guide box 内，适配一个尽可能大的 `targetAspect` 矩形。
// 这样既保留目标几何比例，又保证可见辅助线留在拖拽/缩放出来的选区内。
function fitGoldenRect(
	x: number,
	y: number,
	w: number,
	h: number,
	targetAspect: number = PHI,
) {
	const aspect = w / h;
	let gw = w;
	let gh = h;
	if (aspect > targetAspect) {
		gw = h * targetAspect;
	} else {
		gh = w / targetAspect;
	}
	const gx = x + (w - gw) / 2;
	const gy = y + (h - gh) / 2;
	return { x: gx, y: gy, w: gw, h: gh };
}

// 旋转 90/270 度时，标准横向黄金矩形会变成纵向矩形，所以适配时需要反转宽高比。
function isVerticalRotation(rotation: GuideRotation) {
	return rotation % 2 === 1;
}

/**
 * 在不断缩小的黄金矩形切分中生成相连的四分之一圆弧。
 *
 * 每一轮都会从剩余矩形里切出一个正方形，把这个正方形转成淡淡的结构线，
 * 再生成构成螺旋的四分之一圆弧。
 */
function goldenSpiralBasePrimitives(
	x: number, y: number, w: number, h: number,
	depth: number,
): GuidePrimitive[] {
	let rect = { x, y, w, h };
	const sides: Array<"left" | "top" | "right" | "bottom"> = ["left", "top", "right", "bottom"];
	const primitives: GuidePrimitive[] = [];

	for (let i = 0; i < depth && rect.w >= 1.5 && rect.h >= 1.5; i++) {
		const side = sides[i % sides.length];
		const s = Math.min(rect.w, rect.h);
		let sqX = rect.x, sqY = rect.y;
		let cx = rect.x, cy = rect.y;
		let startAngle = 0;

		if (side === "left") {
			sqX = rect.x; sqY = rect.y;
			cx = sqX + s; cy = sqY + s; startAngle = Math.PI;
			rect = { x: rect.x + s, y: rect.y, w: rect.w - s, h: rect.h };
		} else if (side === "top") {
			sqX = rect.x; sqY = rect.y;
			cx = sqX; cy = sqY + s; startAngle = -Math.PI / 2;
			rect = { x: rect.x, y: rect.y + s, w: rect.w, h: rect.h - s };
		} else if (side === "right") {
			sqX = rect.x + rect.w - s; sqY = rect.y;
			cx = sqX; cy = sqY; startAngle = 0;
			rect = { x: rect.x, y: rect.y, w: rect.w - s, h: rect.h };
		} else {
			sqX = rect.x; sqY = rect.y + rect.h - s;
			cx = sqX + s; cy = sqY; startAngle = Math.PI / 2;
			rect = { x: rect.x, y: rect.y, w: rect.w, h: rect.h - s };
		}

		primitives.push(...rectOutlinePrimitives(sqX, sqY, s, s, { alpha: 0.18, dash: [3, 6] }));
		primitives.push({
			kind: "arc",
			center: { x: cx, y: cy },
			radius: s,
			startAngle,
			endAngle: startAngle + Math.PI / 2,
			alpha: 0.88,
			dash: [],
			widthScale: 1.6,
		});
	}

	return primitives;
}

function rectOutlinePrimitives(
	x: number,
	y: number,
	w: number,
	h: number,
	options: Omit<GuideLinePrimitive, "kind" | "from" | "to">,
): GuideLinePrimitive[] {
	return [
		linePrimitive(x, y, x + w, y, options),
		linePrimitive(x + w, y, x + w, y + h, options),
		linePrimitive(x + w, y + h, x, y + h, options),
		linePrimitive(x, y + h, x, y, options),
	];
}

function rotatePoint(point: Point, angle: number, offset: Point): Point {
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	return {
		x: offset.x + point.x * cos - point.y * sin,
		y: offset.y + point.x * sin + point.y * cos,
	};
}

function transformLinePrimitive(primitive: GuideLinePrimitive, transform: (point: Point) => Point): GuideLinePrimitive {
	return {
		...primitive,
		from: transform(primitive.from),
		to: transform(primitive.to),
	};
}

function transformPrimitive(
	primitive: GuidePrimitive,
	transform: (point: Point) => Point,
	angle: number,
): GuidePrimitive {
	if (primitive.kind === "line") return transformLinePrimitive(primitive, transform);
	if (primitive.kind === "dot" || primitive.kind === "circle") {
		return { ...primitive, center: transform(primitive.center) };
	}
	return {
		...primitive,
		center: transform(primitive.center),
		startAngle: primitive.startAngle + angle,
		endAngle: primitive.endAngle + angle,
	};
}

// ─── 黄金分割线 ───

// 黄金分割线和9格类似，差别只是分割点来自 1 / φ，而不是 1 / 3。
function goldenRatioPrimitives(rx: number, ry: number, rw: number, rh: number): GuidePrimitive[] {
	const x1 = rx + rw * INV_PHI, x2 = rx + rw * (1 - INV_PHI);
	const y1 = ry + rh * INV_PHI, y2 = ry + rh * (1 - INV_PHI);
	return [
		...goldenRatioLinePrimitives(rx, ry, rw, rh, 0.78),
		...dotPrimitives([[x1, y1], [x2, y1], [x1, y2], [x2, y2]], 4, 0.94),
	];
}

// 同时用于独立的黄金分割线辅助线，以及螺旋内部淡化显示的参考网格。
function goldenRatioLinePrimitives(
	rx: number,
	ry: number,
	rw: number,
	rh: number,
	alpha: number,
	dash: number[] = [4, 4],
): GuideLinePrimitive[] {
	const x1 = rx + rw * INV_PHI;
	const x2 = rx + rw * (1 - INV_PHI);
	const y1 = ry + rh * INV_PHI;
	const y2 = ry + rh * (1 - INV_PHI);
	return [
		linePrimitive(x1, ry, x1, ry + rh, { alpha, dash }),
		linePrimitive(x2, ry, x2, ry + rh, { alpha, dash }),
		linePrimitive(rx, y1, rx + rw, y1, { alpha, dash }),
		linePrimitive(rx, y2, rx + rw, y2, { alpha, dash }),
	];
}

// ─── 对角十字 ───

// 对角十字由三层构成：两条实线对角线、中心虚线十字、中心参考圆。
function diagonalPrimitives(rx: number, ry: number, rw: number, rh: number): GuidePrimitive[] {
	const cx = rx + rw / 2;
	const cy = ry + rh / 2;
	return [
		linePrimitive(rx, ry, rx + rw, ry + rh, { alpha: 0.58, dash: [] }),
		linePrimitive(rx + rw, ry, rx, ry + rh, { alpha: 0.58, dash: [] }),
		linePrimitive(cx, ry, cx, ry + rh, { alpha: 0.68, dash: [3, 3] }),
		linePrimitive(rx, cy, rx + rw, cy, { alpha: 0.68, dash: [3, 3] }),
		{
			kind: "circle",
			center: { x: cx, y: cy },
			radius: Math.min(rw, rh) * 0.08,
			alpha: 0.48,
			dash: [2, 4],
		},
	];
}
