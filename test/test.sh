#!/bin/bash

# Make the first POST request to get the session ID
response=$(curl -s -X POST http://localhost:3000/api/session)

# Extract the session ID from the JSON response using jq
sessionID=$(echo $response | jq -r '.sessionID')

# Check if sessionID is not empty
if [ -z "$sessionID" ]; then
  echo "Failed to retrieve sessionID"
  exit 1
fi

# Use the session ID in the second POST request
curl -X POST "http://localhost:3000/api/session/$sessionID/player?players=76561198089827268"