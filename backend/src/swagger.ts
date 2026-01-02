import swaggerJsdoc from 'swagger-jsdoc';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'HighFive Bee Monitoring API',
      version: '1.0.0',
      description: 'API for monitoring bee hive modules and nest activity',
      contact: {
        name: 'HighFive Support',
      },
    },
    servers: [
      {
        url: 'http://localhost:3001',
        description: 'Development server',
      },
    ],
    tags: [
      {
        name: 'Modules',
        description: 'Bee hive module management',
      },
      {
        name: 'Health',
        description: 'API health check',
      },
    ],
    components: {
      schemas: {
        Module: {
          type: 'object',
          required: ['id', 'name', 'location', 'status', 'lastApiCall', 'batteryLevel'],
          properties: {
            id: {
              type: 'string',
              description: 'Unique module identifier',
              example: 'hive-001',
            },
            name: {
              type: 'string',
              description: 'Module display name',
              example: 'Garden View',
            },
            location: {
              type: 'object',
              required: ['lat', 'lng'],
              properties: {
                lat: {
                  type: 'number',
                  description: 'Latitude coordinate',
                  example: 47.3769,
                },
                lng: {
                  type: 'number',
                  description: 'Longitude coordinate',
                  example: 8.5417,
                },
              },
            },
            status: {
              type: 'string',
              enum: ['online', 'offline'],
              description: 'Module connectivity status',
              example: 'online',
            },
            lastApiCall: {
              type: 'string',
              format: 'date-time',
              description: 'ISO timestamp of last API communication',
              example: '2026-01-02T12:30:45.123Z',
            },
            batteryLevel: {
              type: 'number',
              minimum: 0,
              maximum: 100,
              description: 'Battery percentage (0-100)',
              example: 85.5,
            },
          },
        },
        DailyProgress: {
          type: 'object',
          required: ['date', 'empty', 'sealed', 'hatched'],
          properties: {
            date: {
              type: 'string',
              format: 'date',
              description: 'Date in ISO format (YYYY-MM-DD)',
              example: '2026-01-02',
            },
            empty: {
              type: 'number',
              minimum: 0,
              maximum: 100,
              description: 'Percentage of empty nest cells',
              example: 20,
            },
            sealed: {
              type: 'number',
              minimum: 0,
              maximum: 100,
              description: 'Percentage of sealed nest cells',
              example: 60,
            },
            hatched: {
              type: 'number',
              minimum: 0,
              maximum: 100,
              description: 'Percentage of hatched nest cells',
              example: 20,
            },
          },
        },
        NestData: {
          type: 'object',
          required: ['nestId', 'beeType', 'dailyProgress'],
          properties: {
            nestId: {
              type: 'number',
              description: 'Unique nest identifier within module',
              example: 1,
            },
            beeType: {
              type: 'string',
              enum: ['blackmasked', 'resin', 'leafcutter', 'orchard'],
              description: 'Bee species type',
              example: 'blackmasked',
            },
            dailyProgress: {
              type: 'array',
              description: 'Daily progress data for the entire year',
              items: {
                $ref: '#/components/schemas/DailyProgress',
              },
            },
          },
        },
        ModuleDetail: {
          allOf: [
            { $ref: '#/components/schemas/Module' },
            {
              type: 'object',
              required: ['nests'],
              properties: {
                nests: {
                  type: 'array',
                  description: 'Array of 12 nests (3 per bee species)',
                  items: {
                    $ref: '#/components/schemas/NestData',
                  },
                },
              },
            },
          ],
        },
        UpdateStatusRequest: {
          type: 'object',
          required: ['status'],
          properties: {
            status: {
              type: 'string',
              enum: ['online', 'offline'],
              description: 'New module status',
              example: 'online',
            },
          },
        },
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'string',
              description: 'Error message',
              example: 'Module not found',
            },
          },
        },
        SuccessMessage: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: 'Success message',
              example: 'Status updated successfully',
            },
          },
        },
        HealthCheck: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              example: 'ok',
            },
            timestamp: {
              type: 'string',
              format: 'date-time',
              example: '2026-01-02T12:30:45.123Z',
            },
          },
        },
      },
    },
  },
  apis: ['./src/app.ts', './src/server.ts'],
};

export const swaggerSpec = swaggerJsdoc(options);
