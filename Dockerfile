FROM mhart/alpine-node:12

COPY ./ /srv/app
WORKDIR /srv/app

RUN mkdir -p /srv/app/endpoints
RUN mkdir -p /srv/app/logs

ARG ELASTICSEARCH_HOST
ARG INDEX_ROTATION
ARG LOG_EVENTS

RUN rm -rf node_modules
RUN npm install --production

VOLUME /srv/app/endpoints
VOLUME /srv/app/logs

EXPOSE 3000
ENTRYPOINT npm start
