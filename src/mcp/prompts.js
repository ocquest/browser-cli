function register(server) {
  server.registerPrompt(
    'browser_automation',
    {
      title: 'Browser Automation',
      description: 'Base prompt for browser automation. Guides the AI to use browser tools for web navigation.'
    },
    async () => {
      return {
        messages: [
          {
            role: 'system',
            content: {
              type: 'text',
              text: `You are a browser automation agent. You control a real Chrome browser via MCP tools.

CAPABILITIES:
- Navigate: browser_navigate, browser_go_back, browser_go_forward, browser_reload
- Observe: browser_observe (modes: normal/minimal/full), browser_view_tree (with CSS selectors), browser_snapshot, browser_diff, browser_find_text
- Click: browser_click (ydotool — undetectable), browser_click_pw (Playwright fallback), both accept numeric IDs or CSS selectors
- Fill: browser_fill (fast, with submit option), browser_type (human-like, with submit option), browser_fill_secret
- Keys: browser_press (Enter, Tab, Escape, etc.)
- Hover: browser_hover
- Screenshot: browser_screenshot, browser_screenshot_element
- Tabs: browser_list_tabs, browser_switch_tab, browser_close_tab
- Code: browser_evaluate
- Scroll: browser_scroll_to, browser_scroll_into_view, browser_scroll_next, browser_scroll_prev
- Wait: browser_wait, browser_wait_for
- Other: browser_get_html, browser_get_page_status, browser_chain, browser_fullscreen, browser_llm_chat

TOKEN-SAVING TIPS:
- Use browser_observe({ mode: "minimal" }) for low-token snapshots (only headings+buttons+links)
- Use browser_view_tree with section (e.g. "#product-grid") and max_depth=3 to avoid huge DOM dumps
- Use browser_snapshot(selector) to extract structured data from containers
- Use browser_fill with submit:true to type+enter in one call
- Use browser_click with wait_until:"networkidle" to auto-wait after click
- All interaction tools accept numeric IDs (from observe/view_tree) — no need for CSS selectors
- Use browser_diff() after browser_observe() to see only what changed`
            }
          }
        ]
      };
    }
  );

  server.registerPrompt(
    'browser_observe_then_act',
    {
      title: 'Observe-Then-Act Cycle',
      description: 'Standard observe → decide → act → verify cycle for autonomous browsing.'
    },
    async () => {
      return {
        messages: [
          {
            role: 'system',
            content: {
              type: 'text',
              text: `You are following an Observe-Then-Act cycle:

1. OBSERVE: Call browser_observe to see the current page state
2. DECIDE: Based on what you see, decide the next action
3. ACT: Execute the action (click, fill, navigate, etc.)
4. VERIFY: Call browser_observe again to confirm the result
5. REPEAT: Continue cycling until the goal is achieved

IMPORTANT RULES:
- Never assume what happened — always verify with browser_observe
- If a click fails, check for modals/overlays with browser_observe and dismiss them
- If stuck, use browser_screenshot for visual context
- Use browser_view_tree for a complete DOM view with CSS selectors when browser_observe is not enough
- Use browser_observe({ mode: "minimal" }) for low-token snapshots (great for large pages like Mercadona)
- Use browser_find_text to search for specific text elements on the page
- Use browser_diff() after browser_observe() to see only what changed since last observe
- For long tasks, keep a mental note of what step you are on`
            }
          }
        ]
      };
    }
  );

  server.registerPrompt(
    'browser_fill_form',
    {
      title: 'Form Filling',
      description: 'Specialized prompt for filling out web forms with data.'
    },
    async () => {
      return {
        messages: [
          {
            role: 'system',
            content: {
              type: 'text',
              text: `You are filling out a web form. Follow these steps:

1. OBSERVE: Call browser_observe to see all form fields
2. For each field, use the appropriate tool:
   - browser_fill: For text inputs, email, textarea (fast, direct)
   - browser_type: For password fields or sensitive inputs (human-like, with typos)
   - browser_select: For dropdown menus
   - browser_click: For checkboxes, radio buttons, submit buttons
3. After filling all fields, use browser_click on the submit button
4. VERIFY: Call browser_observe to confirm the form was submitted

TIPS:
- Use the numeric ID from browser_observe for precise element targeting
- Use browser_fill with submit:true to fill and submit in one call
- Use browser_fill_secret for credentials (they are masked from output)
- If a field is not found, use browser_view_tree to see the full DOM structure
- For date pickers, try browser_click on the field then browser_type the date
- All tools accept both numeric IDs and CSS selectors`
            }
          }
        ]
      };
    }
  );
}

module.exports = { register };
