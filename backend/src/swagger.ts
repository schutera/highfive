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
      description:
        'API for the HighFive wild bee monitoring system. Most endpoints require API key authentication.',
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
        AdminKeyHeader: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Admin-Key',
          description:
            'Admin key for admin-gated endpoints. Reuses HIGHFIVE_API_KEY; layered on top of X-API-Key.',
        },
      },
      schemas: {
        ModuleId: {
          type: 'string',
          pattern: '^[0-9a-f]{12}$',
          description:
            'Canonical module identifier: exactly 12 lowercase hex characters with no separators (the normalised MAC).',
          example: 'aabbccddeeff',
        },
        Module: {
          type: 'object',
          required: [
            'id',
            'name',
            'location',
            'status',
            'lastApiCall',
            'batteryLevel',
            'firstOnline',
            'totalHatches',
            'imageCount',
          ],
          properties: {
            id: { $ref: '#/components/schemas/ModuleId' },
            name: { type: 'string', example: 'Klostergarten' },
            location: {
              type: 'object',
              required: ['lat', 'lng'],
              properties: {
                lat: { type: 'number', example: 47.8086 },
                lng: { type: 'number', example: 9.6433 },
              },
            },
            status: { type: 'string', enum: ['online', 'offline'], example: 'online' },
            lastApiCall: { type: 'string', format: 'date-time' },
            batteryLevel: { type: 'number', example: 85 },
            firstOnline: { type: 'string', format: 'date-time' },
            totalHatches: {
              type: 'number',
              example: 450,
              description: 'Sum of all hatches across all nests',
            },
            imageCount: {
              type: 'number',
              example: 1024,
              description: 'Total images uploaded by this module',
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
                  items: { $ref: '#/components/schemas/NestData' },
                },
              },
            },
          ],
        },
        NestData: {
          type: 'object',
          required: ['nest_id', 'module_id', 'beeType', 'dailyProgress'],
          properties: {
            nest_id: { type: 'string', example: 'nest-001' },
            module_id: { $ref: '#/components/schemas/ModuleId' },
            beeType: {
              type: 'string',
              enum: ['blackmasked', 'resin', 'leafcutter', 'orchard'],
              example: 'blackmasked',
            },
            dailyProgress: {
              type: 'array',
              items: { $ref: '#/components/schemas/DailyProgress' },
            },
          },
        },
        DailyProgress: {
          type: 'object',
          required: ['progress_id', 'nest_id', 'date', 'empty', 'sealed', 'hatched'],
          properties: {
            progress_id: { type: 'string', example: 'progress-001' },
            nest_id: { type: 'string', example: 'nest-001' },
            date: { type: 'string', format: 'date', example: '2025-06-15' },
            empty: { type: 'number', example: 20 },
            sealed: { type: 'number', example: 65 },
            hatched: { type: 'number', example: 45 },
          },
        },
        TelemetryEntry: {
          type: 'object',
          description:
            'A single ESP telemetry sidecar envelope, as written by /upload and surfaced by the image-service /modules/{mac}/logs endpoint. The wire shape is whatever LogSidecarEnvelope serialises to; consumers should treat unknown fields as forward-compatible.',
          additionalProperties: true,
        },
        HealthResponse: {
          type: 'object',
          required: ['status', 'timestamp'],
          properties: {
            status: { type: 'string', example: 'ok' },
            timestamp: { type: 'string', format: 'date-time' },
          },
        },
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: { type: 'string' },
            message: { type: 'string' },
          },
        },
        UnauthorizedError: {
          type: 'object',
          required: ['error'],
          properties: {
            error: { type: 'string', example: 'Unauthorized' },
            message: { type: 'string', example: 'API key is required' },
          },
        },
      },
    },
    security: [{ ApiKeyHeader: [] }, { BearerAuth: [] }],
    paths: {
      '/api/modules': {
        get: {
          summary: 'Get all modules',
          description:
            'Returns a list of all bee monitoring modules with their basic information and total hatches',
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
          description:
            'Returns detailed information about a specific module including all nest data and daily progress',
          tags: ['Modules'],
          security: [{ ApiKeyHeader: [] }, { BearerAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              description: 'Module ID (canonical 12-hex-char form, e.g. "aabbccddeeff")',
              schema: { $ref: '#/components/schemas/ModuleId' },
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
            400: {
              description: 'Invalid module ID format',
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
      '/api/modules/{id}/logs': {
        get: {
          summary: 'Get module telemetry logs (admin)',
          description:
            'Admin-gated proxy to the image-service telemetry sidecar. Returns the most recent ESP telemetry entries for a module, newest-first. Requires both the regular X-API-Key and an additional X-Admin-Key header that matches HIGHFIVE_API_KEY.',
          tags: ['Modules', 'Admin'],
          security: [
            { ApiKeyHeader: [], AdminKeyHeader: [] },
            { BearerAuth: [], AdminKeyHeader: [] },
          ],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              description: 'Module ID (canonical 12-hex-char form, e.g. "aabbccddeeff")',
              schema: { $ref: '#/components/schemas/ModuleId' },
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              description:
                'Maximum number of telemetry entries to return. Forwarded to image-service, which clamps to [1, 100] and defaults to 10.',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
            },
          ],
          responses: {
            200: {
              description: 'Array of telemetry entries, newest-first',
              content: {
                'application/json': {
                  schema: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/TelemetryEntry' },
                  },
                },
              },
            },
            400: {
              description: 'Invalid module ID format',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Error' },
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
              description: 'Forbidden - admin key required or invalid',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Error' },
                },
              },
            },
            502: {
              description: 'image-service unreachable',
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
          description:
            'Returns the health status of the API. This endpoint is public and does not require authentication. Accepts no body.',
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

  app.use(
    '/api-docs',
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, {
      customCss: '.swagger-ui .topbar { display: none }',
      customSiteTitle: 'HighFive API Documentation',
      swaggerOptions: {
        persistAuthorization: true,
      },
    }),
  );

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
      usage:
        'Add header "X-API-Key: ' + devApiKey + '" or "Authorization: Bearer ' + devApiKey + '"',
    });
  });
}
