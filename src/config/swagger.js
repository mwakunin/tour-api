import swaggerJsdoc from 'swagger-jsdoc';

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Footloose Adventures API',
      version: '1.0.0',
      description:
        'Enterprise-grade REST API for safari tour bookings, payments, and operations management',
      contact: {
        name: 'Footloose Adventures',
        email: 'footlooseadventures2026@gmail.com',
      },
      license: {
        name: 'ISC',
        url: 'https://opensource.org/licenses/ISC',
      },
    },
    servers: [
      {
        url: 'http://localhost:3000',
        description: 'Development server',
      },
      {
        url: 'https://api.footlooseadventures.co.ke',
        description: 'Production server',
      },
    ],
    components: {
      securitySchemes: {
        sessionAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'connect.sid',
          description: 'Session-based authentication using Kinde OAuth',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              example: false,
            },
            error: {
              type: 'string',
              example: 'Error message',
            },
            message: {
              type: 'string',
              example: 'Detailed error description',
            },
          },
        },
        ValidationError: {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              example: false,
            },
            error: {
              type: 'string',
              example: 'Validation error',
            },
            details: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  field: {
                    type: 'string',
                    example: 'email',
                  },
                  message: {
                    type: 'string',
                    example: 'Invalid email format',
                  },
                },
              },
            },
          },
        },
        Tour: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              format: 'uuid',
              example: '123e4567-e89b-12d3-a456-426614174000',
            },
            title: {
              type: 'string',
              example: 'Maasai Mara Safari Adventure',
            },
            slug: {
              type: 'string',
              example: 'maasai-mara-safari-adventure',
            },
            overview: {
              type: 'string',
              example:
                'Experience the breathtaking wildlife of Maasai Mara National Reserve...',
            },
            duration: {
              type: 'integer',
              example: 5,
            },
            duration_unit: {
              type: 'string',
              enum: ['hours', 'days', 'weeks'],
              example: 'days',
            },
            price_amount: {
              type: 'string',
              nullable: true,
              description:
                'Flat base price, CHARGED AS ENTERED. Null for tours priced via pricing_periods.',
              example: '600.00',
            },
            compare_at_amount: {
              type: 'string',
              nullable: true,
              description:
                'Optional struck-through "was" price for the flat rate. Display only — never charged.',
              example: '800.00',
            },
            price_currency: {
              type: 'string',
              enum: ['USD', 'KES'],
              nullable: true,
              example: 'USD',
            },
            discount_percentage: {
              type: 'string',
              readOnly: true,
              description:
                'DERIVED, read-only. The largest saving across all tiers (or the flat compare-at), computed server-side. Values sent by clients are ignored.',
              example: '25.00',
            },
            pricing_periods: {
              type: 'array',
              description:
                'Seasonal pricing. Each period owns a date range and its own tier table. Periods must not overlap. A booking is priced by the period covering its start date; if no period covers it, the booking is rejected.',
              items: {
                type: 'object',
                required: ['start_date', 'end_date', 'pricing_tiers'],
                properties: {
                  label: {
                    type: 'string',
                    maxLength: 100,
                    example: 'Festive Season',
                  },
                  start_date: {
                    type: 'string',
                    format: 'date',
                    description: 'Inclusive, YYYY-MM-DD',
                    example: '2026-12-23',
                  },
                  end_date: {
                    type: 'string',
                    format: 'date',
                    description:
                      'Inclusive, YYYY-MM-DD. May cross a year boundary.',
                    example: '2027-01-02',
                  },
                  pricing_tiers: {
                    type: 'array',
                    minItems: 1,
                    items: {
                      type: 'object',
                      properties: {
                        pax: {
                          type: 'integer',
                          minimum: 1,
                          maximum: 20,
                          example: 2,
                        },
                        price_per_person: {
                          type: 'number',
                          description: 'The price charged, as entered',
                          example: 600,
                        },
                        compare_at_price: {
                          type: 'number',
                          description:
                            'Optional struck-through "was" price. Must exceed price_per_person. Display only — never charged.',
                          example: 800,
                        },
                        total: {
                          type: 'number',
                          example: 1200,
                        },
                        currency: {
                          type: 'string',
                          enum: ['USD', 'KES'],
                          example: 'USD',
                        },
                      },
                    },
                  },
                },
              },
            },
            featured: {
              type: 'boolean',
              example: true,
            },
            is_deal: {
              type: 'boolean',
              example: false,
            },
            images: {
              type: 'array',
              items: {
                type: 'string',
                format: 'uri',
                example:
                  'https://ik.imagekit.io/footlooseadventures/tour-image.jpg',
              },
            },
            cover_image: {
              type: 'string',
              format: 'uri',
              example:
                'https://ik.imagekit.io/footlooseadventures/cover-image.jpg',
            },
            includes: {
              type: 'array',
              items: {
                type: 'string',
                example: 'Accommodation',
              },
            },
            excludes: {
              type: 'array',
              items: {
                type: 'string',
                example: 'International flights',
              },
            },
            itinerary: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  day: {
                    type: 'string',
                    example: 'Day 1',
                  },
                  title: {
                    type: 'string',
                    example: 'Arrival and Setup',
                  },
                  activities: {
                    type: 'string',
                    example: 'Pick up from airport, transfer to lodge...',
                  },
                  accommodation: {
                    type: 'string',
                    example: 'Mara Serena Safari Lodge',
                  },
                  meals: {
                    type: 'string',
                    example: 'Lunch, Dinner',
                  },
                },
              },
            },
            requirements: {
              type: 'string',
              example: 'Valid passport, Yellow fever certificate',
            },
            age_restriction: {
              type: 'object',
              properties: {
                min_age: {
                  type: 'integer',
                  example: 5,
                },
                max_age: {
                  type: 'integer',
                  example: 75,
                },
              },
            },
            tags: {
              type: 'array',
              items: {
                type: 'string',
                example: 'wildlife',
              },
            },
            categories: {
              type: 'array',
              items: {
                type: 'string',
                enum: [
                  'adventure',
                  'cultural',
                  'wildlife',
                  'beach',
                  'luxury',
                  'budget',
                  'family',
                  'honeymoon',
                  'group',
                  'private',
                ],
                example: 'wildlife',
              },
            },
            status: {
              type: 'string',
              enum: ['draft', 'published', 'archived'],
              example: 'published',
            },
            meta_title: {
              type: 'string',
              example: 'Maasai Mara Safari - Best Wildlife Tours',
            },
            meta_description: {
              type: 'string',
              example: 'Discover the amazing wildlife of Maasai Mara...',
            },
            created_at: {
              type: 'string',
              format: 'date-time',
              example: '2025-01-01T00:00:00Z',
            },
            updated_at: {
              type: 'string',
              format: 'date-time',
              example: '2025-01-15T10:30:00Z',
            },
          },
        },
        TourWithDestinations: {
          allOf: [
            {
              $ref: '#/components/schemas/Tour',
            },
            {
              type: 'object',
              properties: {
                tourDestinations: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      destination: {
                        $ref: '#/components/schemas/Destination',
                      },
                      order: {
                        type: 'integer',
                        example: 1,
                      },
                    },
                  },
                },
              },
            },
          ],
        },
        Destination: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              format: 'uuid',
            },
            name: {
              type: 'string',
              example: 'Maasai Mara',
            },
            country: {
              type: 'string',
              example: 'Kenya',
            },
            description: {
              type: 'string',
              example: 'Renowned for the Great Migration...',
            },
            images: {
              type: 'array',
              items: {
                type: 'string',
                format: 'uri',
              },
            },
            created_at: {
              type: 'string',
              format: 'date-time',
            },
            updated_at: {
              type: 'string',
              format: 'date-time',
            },
          },
        },
        Booking: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              format: 'uuid',
            },
            booking_reference: {
              type: 'string',
              example: 'FA-2025-000123',
            },
            tour_id: {
              type: 'string',
              format: 'uuid',
            },
            user_id: {
              type: 'integer',
            },
            group_size: {
              type: 'integer',
              example: 4,
            },
            start_date: {
              type: 'string',
              format: 'date-time',
              example: '2025-06-15T00:00:00Z',
            },
            end_date: {
              type: 'string',
              format: 'date-time',
              example: '2025-06-20T00:00:00Z',
            },
            price_per_person: {
              type: 'string',
              example: '800.00',
            },
            total_price: {
              type: 'string',
              example: '3200.00',
            },
            currency: {
              type: 'string',
              enum: ['USD', 'KES'],
              example: 'USD',
            },
            customer_name: {
              type: 'string',
              example: 'John Doe',
            },
            customer_email: {
              type: 'string',
              format: 'email',
              example: 'john@example.com',
            },
            customer_phone: {
              type: 'string',
              example: '+254712345678',
            },
            country: {
              type: 'string',
              example: 'Kenya',
            },
            special_requests: {
              type: 'string',
              example: 'Vegetarian meals required',
            },
            payment_status: {
              type: 'string',
              enum: [
                'pending',
                'processing',
                'completed',
                'failed',
                'refunded',
              ],
              example: 'pending',
            },
            payment_method: {
              type: 'string',
              example: 'mpesa',
            },
            payment_id: {
              type: 'string',
            },
            status: {
              type: 'string',
              enum: ['pending', 'confirmed', 'cancelled', 'completed'],
              example: 'pending',
            },
            cancelled_at: {
              type: 'string',
              format: 'date-time',
            },
            cancellation_reason: {
              type: 'string',
            },
            created_at: {
              type: 'string',
              format: 'date-time',
            },
            updated_at: {
              type: 'string',
              format: 'date-time',
            },
          },
        },
        Payment: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              format: 'uuid',
            },
            booking_id: {
              type: 'string',
              format: 'uuid',
            },
            amount: {
              type: 'string',
              example: '3200.00',
            },
            currency: {
              type: 'string',
              enum: ['USD', 'KES'],
              example: 'USD',
            },
            payment_method: {
              type: 'string',
              enum: ['mpesa', 'paystack', 'card', 'bank_transfer'],
              example: 'mpesa',
            },
            status: {
              type: 'string',
              enum: [
                'pending',
                'processing',
                'completed',
                'failed',
                'refunded',
              ],
              example: 'completed',
            },
            reference: {
              type: 'string',
              example: 'PAY-2025-001234',
            },
            provider_reference: {
              type: 'string',
              example: 'MPESA-ABC123XYZ',
            },
            metadata: {
              type: 'object',
            },
            created_at: {
              type: 'string',
              format: 'date-time',
            },
            updated_at: {
              type: 'string',
              format: 'date-time',
            },
          },
        },
        User: {
          type: 'object',
          properties: {
            id: {
              type: 'integer',
            },
            kinde_id: {
              type: 'string',
            },
            email: {
              type: 'string',
              format: 'email',
            },
            name: {
              type: 'string',
            },
            role: {
              type: 'string',
              enum: ['user', 'admin'],
              example: 'user',
            },
            created_at: {
              type: 'string',
              format: 'date-time',
            },
            updated_at: {
              type: 'string',
              format: 'date-time',
            },
          },
        },
      },
      responses: {
        UnauthorizedError: {
          description: 'Authentication required',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/Error',
              },
              example: {
                success: false,
                error: 'Authentication required',
                message: 'No active session',
              },
            },
          },
        },
        ForbiddenError: {
          description: 'Insufficient permissions',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/Error',
              },
              example: {
                success: false,
                error: 'Access denied',
                message: 'Insufficient permissions',
              },
            },
          },
        },
        NotFoundError: {
          description: 'Resource not found',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/Error',
              },
              example: {
                success: false,
                error: 'Not found',
                message: 'Resource not found',
              },
            },
          },
        },
        ValidationError: {
          description: 'Validation error',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ValidationError',
              },
            },
          },
        },
        ServerError: {
          description: 'Internal server error',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/Error',
              },
              example: {
                success: false,
                error: 'Internal server error',
                message: 'An unexpected error occurred',
              },
            },
          },
        },
      },
    },
    tags: [
      {
        name: 'Health',
        description: 'API health check endpoints',
      },
      {
        name: 'Authentication',
        description: 'User authentication and authorization endpoints',
      },
      {
        name: 'Tours',
        description: 'Safari tour management',
      },
      {
        name: 'Destinations',
        description: 'Destination management',
      },
      {
        name: 'Bookings',
        description: 'Tour booking operations',
      },
      {
        name: 'Payments',
        description: 'Payment processing',
      },
      {
        name: 'Uploads',
        description: 'File upload operations',
      },
      {
        name: 'Users',
        description: 'User management',
      },
      {
        name: 'Blog',
        description: 'Blog post management',
      },
      {
        name: 'Contact',
        description: 'Contact form submissions',
      },
      {
        name: 'Inquiries',
        description: 'Tour inquiry management',
      },
    ],
  },
  apis: [
    './src/routes/*.js',
    './src/controllers/*.js',
    './src/models/*.js',
    './src/docs/*.js',
  ],
};

export const swaggerSpec = swaggerJsdoc(options);
