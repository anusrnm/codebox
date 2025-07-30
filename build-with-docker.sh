#!/bin/bash

docker build -t mvn-clean:latest .

docker run --rm --entrypoint cat mvn-clean /home/user/app/mvn-clean > mvn-clean

chmod +x mvn-clean