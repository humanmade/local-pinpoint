FROM node:14-alpine3.14

COPY ./ /srv/app
WORKDIR /srv/app

RUN mkdir -p /srv/app/endpoints

ARG ELASTICSEARCH_HOST
ARG INDEX_ROTATION

RUN rm -rf node_modules
RUN npm install --production

VOLUME /srv/app/endpoints

EXPOSE 3000
ENTRYPOINT npm start
