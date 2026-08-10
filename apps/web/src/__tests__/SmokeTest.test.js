// @vitest-environment jsdom

import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import SmokeTest from "./SmokeTest.vue";

describe("Vue SFC pipeline smoke test", () => {
  it("parses .vue SFC and renders output", () => {
    const wrapper = mount(SmokeTest);
    expect(wrapper.find('[data-testid="smoke"]').text()).toBe("hello");
  });

  it("supports reactive updates", async () => {
    const wrapper = mount(SmokeTest);
    const btn = wrapper.find('[data-testid="increment"]');
    expect(btn.text()).toBe("0");
    await btn.trigger("click");
    expect(btn.text()).toBe("1");
  });
});
