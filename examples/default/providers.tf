provider "aws" {
  region  = local.aws_region
  version = "2.61"
  assume_role {
    role_arn = "arn:aws:iam::557218779171:role/runners-deploy"
  }
}

