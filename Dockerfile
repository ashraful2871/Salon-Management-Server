FROM node:24

WORKDIR /salon-backend

COPY . .

RUN npm install

EXPOSE 5000


CMD ["npm", "run", "dev"]


