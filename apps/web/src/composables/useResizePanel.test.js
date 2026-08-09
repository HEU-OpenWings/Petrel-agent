// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { useResizePanel } from "./useResizePanel.js";

/** 构造一个带 pointer capture 桩的把手元素 */
function createHandle() {
  const handle = document.createElement("div");
  handle.setPointerCapture = vi.fn();
  handle.releasePointerCapture = vi.fn();
  return handle;
}

function pointerEvent(type, clientX) {
  const event = new Event(type, { bubbles: true });
  event.clientX = clientX;
  event.pointerId = 1;
  return event;
}

describe("useResizePanel", () => {
  it("向左拖动把手时宽度增加", () => {
    let width = 360;
    const { onPointerDown } = useResizePanel({
      getWidth: () => width,
      setWidth: (next) => {
        width = next;
      },
    });

    const handle = createHandle();
    const down = pointerEvent("pointerdown", 1000);
    Object.defineProperty(down, "target", { value: handle });
    onPointerDown(down);

    window.dispatchEvent(pointerEvent("pointermove", 900));
    expect(width).toBe(460);
  });

  it("向右拖动把手时宽度减少", () => {
    let width = 360;
    const { onPointerDown } = useResizePanel({
      getWidth: () => width,
      setWidth: (next) => {
        width = next;
      },
    });

    const handle = createHandle();
    const down = pointerEvent("pointerdown", 1000);
    Object.defineProperty(down, "target", { value: handle });
    onPointerDown(down);

    window.dispatchEvent(pointerEvent("pointermove", 1050));
    expect(width).toBe(310);
  });

  it("松开后继续移动不再改变宽度", () => {
    let width = 360;
    const { onPointerDown } = useResizePanel({
      getWidth: () => width,
      setWidth: (next) => {
        width = next;
      },
    });

    const handle = createHandle();
    const down = pointerEvent("pointerdown", 1000);
    Object.defineProperty(down, "target", { value: handle });
    onPointerDown(down);

    window.dispatchEvent(pointerEvent("pointermove", 900));
    window.dispatchEvent(pointerEvent("pointerup", 900));
    window.dispatchEvent(pointerEvent("pointermove", 700));

    expect(width).toBe(460);
  });

  it("拖动结束后恢复文本选中", () => {
    const { onPointerDown } = useResizePanel({ getWidth: () => 360, setWidth: () => {} });

    const handle = createHandle();
    const down = pointerEvent("pointerdown", 1000);
    Object.defineProperty(down, "target", { value: handle });
    onPointerDown(down);
    expect(document.body.style.userSelect).toBe("none");

    window.dispatchEvent(pointerEvent("pointerup", 1000));
    expect(document.body.style.userSelect).toBe("");
  });
});
