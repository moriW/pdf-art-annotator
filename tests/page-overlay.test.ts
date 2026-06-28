import { describe, expect, it } from "vitest";
import { canDrawWithPointer, isPenLikePointer } from "../src/page-overlay";

function pointer(overrides: Partial<PointerEvent>): PointerEvent {
  return {
    pointerType: "touch",
    pressure: 0.5,
    width: 20,
    height: 20,
    tiltX: 0,
    tiltY: 0,
    twist: 0,
    tangentialPressure: 0,
    ...overrides,
  } as unknown as PointerEvent;
}

describe("canDrawWithPointer", () => {
  it("accepts explicit pen and mouse pointers", () => {
    expect(canDrawWithPointer(pointer({ pointerType: "pen" }))).toBe(true);
    expect(canDrawWithPointer(pointer({ pointerType: "mouse" }))).toBe(true);
  });

  it("lets ordinary finger touch use tools until pen input is preferred", () => {
    const touch = pointer({ pointerType: "touch", width: 20, height: 18, pressure: 0.5 });
    expect(canDrawWithPointer(touch)).toBe(true);
    expect(canDrawWithPointer(touch, true)).toBe(false);
  });

  it("accepts touch events that look like a stylus", () => {
    const pressureTouch = pointer({ pointerType: "touch", width: 2, height: 2, pressure: 0.72 });
    const tiltedTouch = pointer({ pointerType: "touch", width: 20, height: 18, tiltX: 12 });
    expect(canDrawWithPointer(pressureTouch, true)).toBe(true);
    expect(canDrawWithPointer(tiltedTouch, true)).toBe(true);
    expect(isPenLikePointer(pressureTouch)).toBe(true);
    expect(isPenLikePointer(tiltedTouch)).toBe(true);
  });
});
