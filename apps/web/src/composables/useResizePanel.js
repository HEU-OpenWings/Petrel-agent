import { onUnmounted } from 'vue'

/**
 * 右栏拖拽。
 *
 * 监听挂在 window 而不是把手元素上：指针移出把手甚至移出窗口时拖拽仍要继续，
 * 这是拖拽交互的基本预期。
 *
 * @param {{ getWidth: () => number, setWidth: (width: number) => void }} options
 */
export function useResizePanel({ getWidth, setWidth }) {
  let startX = 0
  let startWidth = 0

  function onPointerMove(event) {
    // 右栏贴在屏幕右侧，把手左移 = 变宽
    setWidth(startWidth + (startX - event.clientX))
  }

  function stop() {
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', stop)
    document.body.style.userSelect = ''
  }

  function onPointerDown(event) {
    startX = event.clientX
    startWidth = getWidth()
    event.target?.setPointerCapture?.(event.pointerId)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', stop)
    // 拖拽过程中禁止选中，否则光标扫过文字会拉出一片蓝色高亮
    document.body.style.userSelect = 'none'
  }

  onUnmounted(stop)

  return { onPointerDown }
}
