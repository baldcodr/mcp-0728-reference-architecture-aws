terraform {
  required_version = "= 1.15.8"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.40"
    }
  }

  # Enterprise deployments: configure a remote backend with state locking
  # before first apply, for example:
  #
  # backend "s3" {
  #   bucket       = "your-tf-state-bucket"
  #   key          = "mcp-ref/foundation.tfstate"
  #   region       = "eu-west-2"
  #   use_lockfile = true
  # }
}

provider "aws" {
  region = var.aws_region
}
