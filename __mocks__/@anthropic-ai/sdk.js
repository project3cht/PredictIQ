// Manual singleton mock — shared across jest.resetModules() via global.
// Allows test file's top-level `Anthropic` reference to configure the mock
// that freshly-required modules (after resetModules) also pick up.

if (!global.__anthropicMockImpl__) {
  global.__anthropicMockImpl__ = null;
}

function AnthropicMock(opts) {
  if (global.__anthropicMockImpl__) {
    return global.__anthropicMockImpl__(opts);
  }
  return {};
}

AnthropicMock.mockImplementation = function (fn) {
  global.__anthropicMockImpl__ = fn;
};

AnthropicMock.mock = { calls: [] };

module.exports = AnthropicMock;
