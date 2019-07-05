Local AWS Pinpoint Server
========================

This is a barebones mock image for testing AWS Cognito & Pinpoint. It is ideal for Amplify JS or any other implementation of client side Pinpoint anayltics.

## API

The following AWS SDK API commands are supported:

- `UpdateEndpoint`: Updates and stores endpoint data for the given Cognito identity ID.
- `PutEvents`: Sends event data to Pinpoint, this is then merged with the corresponding endpoint data and delivered to elasticsearch.

## Docker compose usage

```yaml
services:
  cognito:
    image: humanmade/local-pinpoint
    ports:
      - 3000
    environment:
      ELASTICSEARCH_HOST: http://elasticsearch:9200
    networks:
      - default
  elasticsearch:
    image: blacktop/elasticsearch
    ports:
      - 9200
    networks:
      - default

networks:
  default:
    external:
      name: default
```
      
## Local Pinpoint

This image is a counterpart to [local-cognito](https://github.com/humanmade/local-cognito) but can also be used with a live Cognito Idenitity Pool instance.
