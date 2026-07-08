const { send } = require('../send');

module.exports = function (program) {
  program
    .command('llm')
    .description('Send a text prompt to the LLM and print the response. Requires BR_LLM_API_KEY or --api-key on start.')
    .argument('<prompt...>', 'The prompt text to send.')
    .action(async (prompt) => {
      try {
        const text = prompt.join(' ');
        const result = await send('/llm/chat', 'POST', { messages: [text] });
        const parsed = JSON.parse(result);
        console.log(parsed.result || result);
      } catch (error) {
        console.error('Error calling LLM:', error);
      }
    });
};
