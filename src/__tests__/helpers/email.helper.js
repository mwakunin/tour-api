// src/__tests__/helpers/email.helper.js

/**
 * Mock email helper for testing
 * Use this to verify emails without actually sending them
 */
/*
const _mockEmailQueue = [];

/**
 * Get mock Resend instance
 *
export const getMockResend = () => {
  const { Resend } = require('resend');
  const mockInstance = new Resend();
  return mockInstance.emails;
};

/**
 * Clear all mock email calls
 *
export const clearMockEmails = () => {
  jest.clearAllMocks();
  mockEmailQueue = [];
};

/**
 * Get all sent emails from mock
 *
export const getSentEmails = () => {
  const mockResend = getMockResend();
  return mockResend.send.mock.calls.map((call) => call[0]);
};

/**
 * Get last sent email
 *
export const getLastSentEmail = () => {
  const emails = getSentEmails();
  return emails[emails.length - 1];
};

/**
 * Find email by recipient
 *
export const findEmailByRecipient = (email) => {
  const emails = getSentEmails();
  return emails.find((e) => e.to.includes(email));
};

/**
 * Find email by subject
 *
export const findEmailBySubject = (subject) => {
  const emails = getSentEmails();
  return emails.find((e) => e.subject.includes(subject));
};

/**
 * Verify email was sent
 *
export const expectEmailSent = (options = {}) => {
  const emails = getSentEmails();

  if (options.count !== undefined) {
    expect(emails.length).toBe(options.count);
  }

  if (options.to) {
    const found = findEmailByRecipient(options.to);
    expect(found).toBeDefined();
  }

  if (options.subject) {
    const found = findEmailBySubject(options.subject);
    expect(found).toBeDefined();
  }

  return emails;
};

/**
 * Verify no emails were sent
 *
export const expectNoEmailsSent = () => {
  const emails = getSentEmails();
  expect(emails.length).toBe(0);
};

/**
 * Mock successful email sending
 *
export const mockEmailSuccess = (emailId = 'mock-email-123') => {
  const mockResend = getMockResend();
  mockResend.send.mockResolvedValue({
    data: { id: emailId },
    error: null,
  });
};

/**
 * Mock email sending failure
 *
export const mockEmailFailure = (
  errorMessage = 'Email service unavailable'
) => {
  const mockResend = getMockResend();
  mockResend.send.mockRejectedValue(new Error(errorMessage));
};

/**
 * Extract text from HTML email
 *
export const extractTextFromHtml = (html) => {
  return html
    .replace(/<style[^>]*>.*?<\/style>/gs, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

/**
 * Verify email contains text
 *
export const expectEmailContains = (email, text) => {
  const emailText = extractTextFromHtml(email.html);
  expect(emailText).toContain(text);
};
*/
