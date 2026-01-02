# Backend Tests

Comprehensive test suite for the HighFive Backend API using Jest and Supertest.

## Test Coverage

- **37 tests** covering all API endpoints and database operations
- **90.38% code coverage** overall
- 100% coverage on database.ts and swagger.ts

## Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode (auto-rerun on file changes)
npm run test:watch

# Run tests with coverage report
npm run test:coverage
```

## Test Suites

### API Tests (`src/__tests__/api.test.ts`)

Tests all HTTP endpoints using Supertest:

#### Health Check
- ✅ Health endpoint returns status and timestamp

#### Module Listing (GET /api/modules)
- ✅ Returns all modules with correct structure
- ✅ Validates GPS coordinates are within valid ranges
- ✅ Validates status is either 'online' or 'offline'

#### Module Details (GET /api/modules/:id)
- ✅ Returns complete module data including nests
- ✅ Validates nest data structure with daily progress
- ✅ Returns 404 for non-existent modules
- ✅ Validates daily progress data for each nest

#### Status Updates (PATCH /api/modules/:id/status)
- ✅ Successfully updates module status to online
- ✅ Successfully updates module status to offline
- ✅ Returns 400 for invalid status values
- ✅ Returns 404 for non-existent modules
- ✅ Handles missing request body

#### Documentation
- ✅ Swagger JSON spec is accessible and valid

#### CORS & Error Handling
- ✅ CORS headers are present
- ✅ 404 responses for undefined routes

### Database Tests (`src/__tests__/database.test.ts`)

Tests the mock database operations:

#### Module Retrieval
- ✅ Returns array of modules with correct properties
- ✅ Battery levels are within 0-100%
- ✅ German module names (Klostergarten, Wiesengrund, etc.)
- ✅ GPS coordinates in Weingarten/Ravensburg area

#### Module Details
- ✅ Returns full details for valid module IDs
- ✅ Returns null for non-existent IDs
- ✅ Each module has exactly 12 nests
- ✅ Nests have correct structure (nestId, beeType, dailyProgress)
- ✅ All 4 bee types present (blackmasked, resin, leafcutter, orchard)
- ✅ 3 nests per bee type
- ✅ Daily progress data with valid dates and counts

#### Status Updates
- ✅ Updates module status successfully
- ✅ Returns false for non-existent modules
- ✅ Updates lastApiCall timestamp
- ✅ Maintains other properties when updating

#### Data Consistency
- ✅ All module IDs are unique
- ✅ All nest IDs are unique within each module
- ✅ firstOnline dates are in the past

## Test Structure

```
backend/
├── src/
│   ├── __tests__/
│   │   ├── api.test.ts        # API endpoint tests
│   │   └── database.test.ts   # Database operation tests
│   ├── app.ts                 # Express app (tested)
│   ├── database.ts            # Mock database (tested)
│   ├── swagger.ts             # API documentation (tested)
│   └── server.ts              # Server startup (not tested)
├── jest.config.js             # Jest configuration
└── coverage/                  # Generated coverage reports
```

## Coverage Report

```
-------------|---------|----------|---------|---------|-------------------
File         | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s 
-------------|---------|----------|---------|---------|-------------------
All files    |   90.38 |      100 |   94.73 |      90 |                   
 app.ts      |   91.89 |      100 |     100 |   91.89 | 56,105,172        
 database.ts |     100 |      100 |     100 |     100 |                   
 swagger.ts  |     100 |      100 |     100 |     100 |                   
-------------|---------|----------|---------|---------|-------------------
```

## Technologies

- **Jest**: Testing framework
- **Supertest**: HTTP assertion library for API testing
- **ts-jest**: TypeScript preprocessor for Jest
- **TypeScript**: Type-safe test code

## Writing New Tests

When adding new endpoints or features:

1. Add test cases to the appropriate test file
2. Follow the existing test structure and naming conventions
3. Run `npm run test:coverage` to ensure coverage remains high
4. Aim for at least 90% coverage on new code

### Example Test

```typescript
describe('New Feature', () => {
  it('should do something expected', async () => {
    const response = await request(app)
      .get('/api/new-endpoint')
      .expect(200);
    
    expect(response.body).toHaveProperty('expectedField');
  });
});
```
