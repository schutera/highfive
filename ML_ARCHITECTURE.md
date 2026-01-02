# ML Service Architecture

## Neural Network for Image Analysis

### Recommended: Docker Microservice Approach

Keep the architecture lean and maintainable by separating concerns:

```
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│   ESP32 Module  │─────▶│  Node.js API    │─────▶│  ML Service     │
│   (Camera)      │      │  (TypeScript)   │      │  (Python)       │
└─────────────────┘      └─────────────────┘      └─────────────────┘
                                │                          │
                                ▼                          ▼
                         ┌─────────────┐          ┌──────────────┐
                         │   Storage   │          │ TensorFlow/  │
                         │ (Images/DB) │          │   PyTorch    │
                         └─────────────┘          └──────────────┘
```

## Why Docker for ML Service?

- ✅ **Isolated Dependencies**: Heavy Python ML libraries (TensorFlow, PyTorch, OpenCV) don't bloat Node.js backend
- ✅ **Independent Scaling**: Image processing is CPU/GPU intensive - can scale separately from API
- ✅ **Language Flexibility**: Use Python for ML (better ecosystem) while keeping TypeScript for API
- ✅ **Easy Updates**: Update model versions without touching API code
- ✅ **Development**: Run ML service only when needed during development

## Implementation Plan

### 1. Node.js API (Current backend - stays lean)

- Receives image uploads from ESP32
- Stores raw images in file system or S3
- Sends image processing jobs to ML service via REST or message queue (RabbitMQ/Redis)
- Receives processed results and updates database
- Serves data to frontend

### 2. ML Service (New Docker container)

- Python FastAPI or Flask service
- Loads pre-trained neural network model
- Processes images: bee detection, counting, species classification
- Returns structured JSON results
- Can be deployed on separate server with GPU

### 3. Communication Options

**Synchronous (Simple):**
- Direct HTTP requests between services
- Works well for small deployments
- Node.js API waits for ML processing to complete

**Asynchronous (Scalable):**
- Message queue like Redis or RabbitMQ
- Better for handling bursts of images
- Non-blocking - API responds immediately, processes in background

## Project Structure

```bash
highfive/
├── backend/
│   ├── src/              # Existing Node.js API (TypeScript)
│   ├── package.json
│   └── tsconfig.json
│
├── ml-service/
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── app.py           # FastAPI service
│   ├── models/          # Trained ML models
│   │   ├── bee_detector.h5
│   │   └── species_classifier.h5
│   └── utils/
│       ├── image_processing.py
│       └── inference.py
│
└── docker-compose.yml
```

## Docker Setup

### docker-compose.yml

```yaml
version: '3.8'

services:
  api:
    build: ./backend
    ports:
      - "3001:3001"
    environment:
      - ML_SERVICE_URL=http://ml-service:5000
      - NODE_ENV=production
    depends_on:
      - ml-service
    volumes:
      - ./images:/app/images

  ml-service:
    build: ./ml-service
    ports:
      - "5000:5000"
    environment:
      - MODEL_PATH=/app/models
    volumes:
      - ./ml-service/models:/app/models
    # Optional: GPU support
    # deploy:
    #   resources:
    #     reservations:
    #       devices:
    #         - driver: nvidia
    #           capabilities: [gpu]

  # Optional: Redis for async processing
  redis:
    image: redis:alpine
    ports:
      - "6379:6379"
```

### ML Service Dockerfile

```dockerfile
FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    libgl1-mesa-glx \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application
COPY . .

# Expose port
EXPOSE 5000

# Run application
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "5000"]
```

### requirements.txt

```
fastapi==0.109.0
uvicorn==0.27.0
tensorflow==2.15.0
# or pytorch
# torch==2.1.0
# torchvision==0.16.0
opencv-python-headless==4.9.0
pillow==10.2.0
numpy==1.26.3
pydantic==2.5.0
```

## ML Service API Endpoints

### POST /analyze
Analyze an image and return bee detection results

**Request:**
```json
{
  "image_url": "http://api:3001/images/module-001/2026-01-02-12-30-45.jpg",
  "module_id": "hive-001",
  "timestamp": "2026-01-02T12:30:45Z"
}
```

**Response:**
```json
{
  "module_id": "hive-001",
  "timestamp": "2026-01-02T12:30:45Z",
  "processing_time_ms": 245,
  "results": {
    "bees_detected": 12,
    "nests_active": 8,
    "species_breakdown": [
      {
        "beeType": "blackmasked",
        "count": 3,
        "confidence": 0.92
      },
      {
        "beeType": "resin",
        "count": 4,
        "confidence": 0.89
      },
      {
        "beeType": "leafcutter",
        "count": 3,
        "confidence": 0.91
      },
      {
        "beeType": "orchard",
        "count": 2,
        "confidence": 0.87
      }
    ],
    "nest_status": [
      {
        "nestId": 1,
        "status": "active",
        "eggs_detected": 5,
        "sealed_cells": 3,
        "hatched_cells": 2
      }
    ]
  }
}
```

### GET /health
Health check endpoint

**Response:**
```json
{
  "status": "ok",
  "model_loaded": true,
  "gpu_available": false
}
```

## Node.js API Integration

### Add ML Service Client

```typescript
// backend/src/services/mlService.ts
import axios from 'axios';

const ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://localhost:5000';

export interface AnalysisRequest {
  image_url: string;
  module_id: string;
  timestamp: string;
}

export interface AnalysisResult {
  module_id: string;
  timestamp: string;
  processing_time_ms: number;
  results: {
    bees_detected: number;
    nests_active: number;
    species_breakdown: Array<{
      beeType: string;
      count: number;
      confidence: number;
    }>;
    nest_status: Array<{
      nestId: number;
      status: string;
      eggs_detected: number;
      sealed_cells: number;
      hatched_cells: number;
    }>;
  };
}

export async function analyzeImage(request: AnalysisRequest): Promise<AnalysisResult> {
  const response = await axios.post(`${ML_SERVICE_URL}/analyze`, request);
  return response.data;
}

export async function checkMLServiceHealth(): Promise<boolean> {
  try {
    const response = await axios.get(`${ML_SERVICE_URL}/health`);
    return response.data.status === 'ok';
  } catch (error) {
    return false;
  }
}
```

### Image Upload Endpoint

```typescript
// backend/src/app.ts
import multer from 'multer';
import { analyzeImage } from './services/mlService';

const upload = multer({ dest: 'uploads/' });

app.post('/api/modules/:id/upload', upload.single('image'), async (req, res) => {
  try {
    const moduleId = req.params.id;
    const imageFile = req.file;
    
    if (!imageFile) {
      return res.status(400).json({ error: 'No image provided' });
    }

    // Store image
    const imageUrl = `http://localhost:3001/images/${moduleId}/${imageFile.filename}`;
    
    // Send to ML service for analysis
    const analysis = await analyzeImage({
      image_url: imageUrl,
      module_id: moduleId,
      timestamp: new Date().toISOString()
    });
    
    // Update database with results
    db.updateModuleData(moduleId, analysis);
    
    res.json({
      message: 'Image uploaded and analyzed successfully',
      analysis
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to process image' });
  }
});
```

## Benefits of This Approach

- **Current Node.js backend remains fast and lightweight** - No heavy ML dependencies
- **ML service can use GPU acceleration** without affecting API
- **Can develop/test ML model independently** - Update models without redeploying API
- **Easy to add multiple ML workers** for parallel processing
- **Simple rollback** if ML model needs updates
- **Development flexibility** - Run API without ML service for frontend development

## Development Workflow

### Local Development (Without Docker)

```bash
# Terminal 1: Run Node.js API
cd backend
npm run dev

# Terminal 2: Run ML Service
cd ml-service
pip install -r requirements.txt
uvicorn app:app --reload --port 5000

# Terminal 3: Run Frontend
cd homepage
npm run dev
```

### Production (With Docker)

```bash
# Build and start all services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop services
docker-compose down
```

## Future Enhancements

- **Model Training Pipeline**: Add scripts to retrain models with new data
- **Model Versioning**: A/B test different model versions
- **Batch Processing**: Process multiple images in parallel
- **Real-time Streaming**: Use WebSockets for live analysis updates
- **Edge Computing**: Run lightweight model on ESP32 for preliminary filtering
