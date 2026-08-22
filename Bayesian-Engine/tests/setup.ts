import "@testing-library/jest-dom/vitest";

class ResizeObserverMock implements ResizeObserver {
  disconnect(): void {
    return;
  }

  observe(): void {
    return;
  }

  unobserve(): void {
    return;
  }
}

globalThis.ResizeObserver = ResizeObserverMock;
