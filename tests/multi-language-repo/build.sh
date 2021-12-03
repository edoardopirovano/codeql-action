#!/bin/bash

dotnet build --no-incremental -t:Clean -p:UseSharedCompilation=false
