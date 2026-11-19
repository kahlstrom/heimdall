module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'Example error-severity rule. Replace with the repo architecture rules.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
  },
};
