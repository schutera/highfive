import os
from datetime import datetime

import boto3
from dotenv import load_dotenv
from PIL import Image

# Load .env file
load_dotenv()

endpoint = os.getenv("AWS_ENDPOINT")
access_key = os.getenv("AWS_ACCESS_KEY_ID")
secret_key = os.getenv("AWS_SECRET_ACCESS_KEY")


class AWSClient:
    def __init__(self):
        if endpoint and access_key and secret_key:
            self.s3 = boto3.client(
                "s3",
                endpoint_url=endpoint,
                aws_access_key_id=access_key,
                aws_secret_access_key=secret_key,
            )
            print("[S3] Bucket upload initialized...")

    def _convert_to_jpg(self, input_path, output_path=None):
        ext = os.path.splitext(input_path)[1].lower()

        # Skip if already JPG/JPEG
        if ext in [".jpg", ".jpeg"]:
            return input_path

        if output_path is None:
            base, _ = os.path.splitext(input_path)
            output_path = base + ".jpg"

        with Image.open(input_path) as img:
            rgb = img.convert("RGB")
            rgb.save(output_path, "JPEG")

        return output_path

    def upload(self, bucket, filename, delete=False):
        if endpoint and access_key and secret_key:
            timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")

            # Convert to JPG if needed
            jpg_file = self._convert_to_jpg(filename)

            key = f"{timestamp}.jpg"

            # Upload to S3
            self.s3.upload_file(Filename=jpg_file, Bucket=bucket, Key=key)

            if delete:
                # Delete original if different
                if jpg_file != filename and os.path.exists(filename):
                    os.remove(filename)

                # Delete JPG file afterwards
                if os.path.exists(jpg_file):
                    os.remove(jpg_file)

            print(f"[S3] Uploaded {key} to /{bucket}")
        else:
            return
