FROM node:latest

WORKDIR /usr/src/app

ENV NODE_ENV production

# Install Node.js dependencies
COPY package*.json /usr/src/app/
RUN npm ci --only=production
RUN npm install pm2 -g

# Copy Node.js files
COPY nsfwjs /usr/src/app/nsfwjs
COPY faceapi /usr/src/app/faceapi
COPY server.js /usr/src/app/server.js

# Expose port 3030 and start Node.js server
EXPOSE 3030
CMD [ "pm2", "start", "server.js", "-i", "max" ]
