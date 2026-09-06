// src/__tests__/globalTeardown.js (or jest.global-teardown.js)
export default async () => {
  console.log('\n🧹 Global Test Teardown Starting...');

  try {
    // Give time for connections to close gracefully
    await new Promise((resolve) => setTimeout(resolve, 1000));

    console.log('✅ Test environment cleaned up');
    console.log('✅ Global teardown complete');
  } catch (error) {
    console.error('❌ Error during teardown:', error);
  }
};
