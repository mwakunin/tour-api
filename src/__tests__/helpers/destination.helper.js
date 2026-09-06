// ============================================
// FILE: src/__tests__/helpers/destination.helper.js
// ============================================
import { db } from '#config/database.js';
import { destinations } from '#models/destination.model.js';
import { eq } from 'drizzle-orm';

/**
 * Create a test destination
 */
export const createTestDestination = async (overrides = {}) => {
  const timestamp = Date.now();

  const destinationData = {
    title: `Test Destination ${timestamp}`,
    slug: `test-destination-${timestamp}`,
    description: 'A test destination for integration testing purposes',
    image: 'https://example.com/test-destination.jpg',
    country: 'Kenya',
    region: 'East Africa',
    featured: false,
    position: 0,
    ...overrides,
  };

  const [destination] = await db
    .insert(destinations)
    .values(destinationData)
    .returning();

  return destination;
};

/**
 * Delete test destination
 */
export const deleteTestDestination = async (destinationId) => {
  await db.delete(destinations).where(eq(destinations.id, destinationId));
};

/**
 * Create multiple test destinations
 */
export const createTestDestinations = async (count = 3) => {
  const created = [];

  for (let i = 0; i < count; i++) {
    const dest = await createTestDestination({
      title: `Test Destination ${i + 1}`,
      slug: `test-destination-${Date.now()}-${i}`,
    });
    created.push(dest);
  }

  return created;
};

/**
 * Delete multiple test destinations
 */
export const deleteTestDestinations = async (destinationIds) => {
  for (const id of destinationIds) {
    await deleteTestDestination(id);
  }
};
