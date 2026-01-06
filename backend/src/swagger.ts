import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import { Express } from 'express';
import { getApiKey } from './auth';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'HighFive API',
      version: '1.0.0',
      description: 'API for the HighFive wild bee monitoring system. Most endpoints require API key authentication.',
      contact: {
        name: 'HighFive Team',
      },
    },
    servers: [
      {
        url: 'http://localhost:3002',
        description: 'Development server',
      },
    ],
    components: {
      securitySchemes: {
        ApiKeyHeader: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: 'API key passed in X-API-Key header',
        },
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'API key passed as Bearer token',
        },
      },
      schemas: {
        Module: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'hive-001' },
            name: { type: 'string', example: 'Klostergarten' },
            location: {
              type: 'object',
              properties: {
                lat: { type: 'number', example: 47.8086 },
                lng: { type: 'number', example: 9.6433 },
              },
            },
            status: { type: 'string', enum: ['online', 'offline'], example: 'online' },
            lastApiCall: { type: 'string', format: 'date-time' },
            batteryLevel: { type: 'number', example: 85 },
            firstOnline: { type: 'string', format: 'date-time' },
            totalHatches: { type: 'number', example: 450, description: 'Sum of all hatches across all nests' },
          },
        },
        ModuleDetail: {
          allOf: [
            { $ref: '#/components/schemas/Module' },
            {
              type: 'object',
              properties: {
                nests: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/NestData' },
                },
              },
            },
          ],
        },
        NestData: {
          type: 'object',
          properties: {
            nestId: { type: 'number', example: 1 },
            beeType: { 
              type: 'string', 
              enum: ['blackmasked', 'resin', 'leafcutter', 'orchard'],
              example: 'blackmasked' 
            },
            dailyProgress: {
              type: 'array',
              items: { $ref: '#/components/schemas/DailyProgress' },
            },
          },
        },
        DailyProgress: {
          type: 'object',
          properties: {
            date: { type: 'string', format: 'date', example: '2025-06-15' },
            empty: { type: 'number', example: 20 },
            sealed: { type: 'number', example: 65 },
            hatched: { type: 'number', example: 45 },
          },
        },
        HealthResponse: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'ok' },
            timestamp: { type: 'string', format: 'date-time' },
          },
        },
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            message: { type: 'string' },
          },
        },
        UnauthorizedError: {
          type: 'object',
          properties: {
            error: { type: 'string', example: 'Unauthorized' },
            message: { type: 'string', example: 'API key is required' },
          },
        },
      },
    },
    security: [
      { ApiKeyHeader: [] },
      { BearerAuth: [] },
    ],
    paths: {
      '/api/modules': {
        get: {
          summary: 'Get all modules',
          description: 'Returns a list of all bee monitoring modules with their basic information and total hatches',
          tags: ['Modules'],
          security: [{ ApiKeyHeader: [] }, { BearerAuth: [] }],
          responses: {
            200: {
              description: 'List of modules',
              content: {
                'application/json': {
                  schema: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/Module' },
                  },
                },
              },
            },
            401: {
              description: 'Unauthorized - API key missing',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/UnauthorizedError' },
                },
              },
            },
            403: {
              description: 'Forbidden - Invalid API key',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Error' },
                },
              },
            },
            500: {
              description: 'Server error',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Error' },
                },
              },
            },
          },
        },
      },
      '/api/modules/{id}': {
        get: {
          summary: 'Get module details',
          description: 'Returns detailed information about a specific module including all nest data and daily progress',
          tags: ['Modules'],
          security: [{ ApiKeyHeader: [] }, { BearerAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              description: 'Module ID',
              schema: { type: 'string' },
              example: 'hive-001',
            },
          ],
          responses: {
            200: {
              description: 'Module details',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ModuleDetail' },
                },
              },
            },
            404: {
              description: 'Module not found',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Error' },
                },
              },
            },
            500: {
              description: 'Server error',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Error' },
                },
              },
            },
          },
        },
      },
      '/api/modules/{id}/status': {
        patch: {
          summary: 'Update module status',
          description: 'Updates the online/offline status of a module',
          tags: ['Modules'],
          security: [{ ApiKeyHeader: [] }, { BearerAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              description: 'Module ID',
              schema: { type: 'string' },
              example: 'hive-001',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['status'],
                  properties: {
                    status: {
                      type: 'string',
                      enum: ['online', 'offline'],
                      example: 'online',
                    },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'Status updated successfully',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      message: { type: 'string', example: 'Status updated successfully' },
                    },
                  },
                },
              },
            },
            400: {
              description: 'Invalid status value',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Error' },
                },
              },
            },
            404: {
              description: 'Module not found',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Error' },
                },
              },
            },
          },
        },
      },
      '/api/health': {
        get: {
          summary: 'Health check',
          description: 'Returns the health status of the API. This endpoint is public and does not require authentication.',
          tags: ['Health'],
          security: [], // Public endpoint, no auth required
          responses: {
            200: {
              description: 'API is healthy',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/HealthResponse' },
                },
              },
            },
          },
        },
      },
    },
  },
  apis: [], // We define everything inline above
};

const swaggerSpec = swaggerJsdoc(options);

export function setupSwagger(app: Express): void {
  // Get the dev API key for display
  const devApiKey = getApiKey();
  
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'HighFive API Documentation',
    swaggerOptions: {
      persistAuthorization: true,
    },
  }));
  
  // Also serve the raw OpenAPI spec
  app.get('/api-docs.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
  });
  
  // Dev endpoint to get the API key (remove in production!)
  app.get('/api-docs/dev-key', (req, res) => {
    res.json({ 
      message: 'Development API key (do not use in production)',
      apiKey: devApiKey,
      usage: 'Add header "X-API-Key: ' + devApiKey + '" or "Authorization: Bearer ' + devApiKey + '"'
    });
  });
}
