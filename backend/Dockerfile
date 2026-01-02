FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Create images directory
RUN mkdir -p /app/images

# Copy source code
COPY src ./src
COPY tsconfig.json ./

# Build TypeScript
RUN npm run build

# Remove source files to reduce image size
RUN rm -rf src tsconfig.json

# Expose port
EXPOSE 3008

# Start server
CMD ["node", "dist/server.js"]
