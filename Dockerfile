FROM mhart/alpine-node:12

COPY ./ /srv/app
WORKDIR /srv/app

RUN mkdir -p /srv/app/endpoints

ARG ELASTICSEARCH_HOST

RUN npm install --production

VOLUME /srv/app/endpoints

EXPOSE 3000
ENTRYPOINT npm start
