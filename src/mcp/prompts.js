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
- Navigate to any URL with browser_navigate
- Observe the current page with browser_observe (get URL, title, interactive elements, text, modals)
- Click elements with browser_click (system-level ydotool — undetectable by anti-bot systems)
- Fill form fields with browser_fill or browser_type (human-like typing)
- Press keyboard keys with browser_press (Enter, Tab, Escape, etc.)
- Take screenshots with browser_screenshot
- Get the DOM tree with browser_view_tree
- Manage tabs with browser_list_tabs, browser_switch_tab, browser_close_tab
- Execute JavaScript with browser_evaluate
- Scroll pages with browser_scroll_*, browser_scroll_to
- Solve slide captchas with browser_solve_slide_captcha

BEST PRACTICES:
1. Always start with browser_observe to understand the page
2. Use browser_click for clicks (it uses ydotool, not detectable)
3. Only use browser_click_pw if browser_click fails
4. After each action, use browser_observe to see the result
5. Use browser_screenshot when you need visual confirmation
6. For form filling, prefer browser_fill for speed, browser_type for stealth

Selectors can be CSS selectors or numeric IDs from browser_observe/browser_view_tree.`
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
- Use browser_view_tree for a complete DOM view when browser_observe is not enough
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
- Use browser_fill_secret for credentials (they are masked from output)
- If a field is not found, use browser_view_tree to see the full DOM structure
- For date pickers, try browser_click on the field then browser_type the date`
            }
          }
        ]
      };
    }
  );
}

module.exports = { register };
