#!/usr/bin/env python3
"""
Envision Legacy — Veo 3.1 Video Pre-Generator
===============================================
Generates animated videos for all 12 Polaroid images using Google's Veo 3.1 API.
Videos are saved as MP4 files in PictureWallSite/videos/ for static serving.

Usage:
    export GEMINI_API_KEY="your-key"
    python3 generate_videos.py

Each generation takes ~30-120 seconds. The script skips images that already
have a cached video in the output directory.
"""

import os
import sys
import time
import base64

from google import genai

# --- Configuration ---
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
IMAGES_DIR = os.path.join(SCRIPT_DIR, "PictureWallSite", "images")
VIDEOS_DIR = os.path.join(SCRIPT_DIR, "PictureWallSite", "videos")
MODEL = "veo-3.1-generate-preview"

# Each entry: (image_filename, animation_prompt)
PHOTO_DATA = [
    (
        "grandma_child.png",
        "Gentle rocking motion of a porch swing, grandmother softly stroking grandchild's hair. Warm golden afternoon light with soft lens flare. Vintage sepia tone, 1940s film grain texture."
    ),
    (
        "father_son_bike.png",
        "A father lets go as his son pedals forward on a bicycle down a tree-lined street. The boy wobbles slightly then rides straight. Warm afternoon light, vintage 1950s film quality."
    ),
    (
        "couple_dancing.png",
        "A young couple slow dancing under string lights at a backyard gathering. Gentle swaying motion, warm golden light, other guests softly blurred in background. 1960s vintage film look."
    ),
    (
        "soldiers_homecoming.png",
        "A soldier and his wife hold each other tightly at a train station. She buries her face in his shoulder. Subtle crowd movement in background. 1940s black and white newsreel grain."
    ),
    (
        "family_picnic.png",
        "A large family at a picnic by a lake, children running across the blanket, adults laughing. Gentle breeze moves the tablecloth. Warm 1950s Kodachrome color palette."
    ),
    (
        "grandpa_fishing.png",
        "An old man and young boy sitting on a dock, fishing rods gently bobbing. Sunset light ripples on calm lake water. Warm vintage 1960s film grain."
    ),
    (
        "wedding_portrait.png",
        "A bride and groom standing before a stone church. Her veil moves gently in the wind, she looks up at him with a soft smile. Classic 1940s wedding film style."
    ),
    (
        "mother_daughter.png",
        "A mother braids her daughter's hair in a sunlit kitchen. Gentle hand movements, dust motes floating in morning light. Warm 1950s home movie style."
    ),
    (
        "kids_playing.png",
        "Children running through a backyard sprinkler laughing and splashing. Water droplets catch the sunlight. Joyful summer energy. Vintage 1960s home movie on 8mm film."
    ),
    (
        "birthday_party.png",
        "A child takes a deep breath and blows out birthday candles on a cake. Candlelight flickers across smiling faces around the table. Warm 1950s home movie style."
    ),
    (
        "elderly_couple_bench.png",
        "An elderly couple sitting on a park bench, the man gently takes her hand. Leaves drift down around them in golden afternoon light. Warm 1970s film quality."
    ),
    (
        "graduation_day.png",
        "A young woman in cap and gown rushes to hug her father. He lifts her slightly off the ground. Joyful crowd in soft focus behind. 1960s film grain."
    ),
]


def generate_video(client, image_path, prompt, output_path, max_retries=3):
    """Generate a video from an image using Veo 3.1 with retry logic."""
    
    # Read and encode the image
    with open(image_path, "rb") as f:
        image_bytes = f.read()
    
    image_b64 = base64.b64encode(image_bytes).decode("utf-8")
    
    for attempt in range(max_retries):
        try:
            if attempt > 0:
                wait_time = 60 * (2 ** (attempt - 1))  # 60s, 120s, 240s
                print(f"  🔄 Retry {attempt}/{max_retries-1} — waiting {wait_time}s...")
                time.sleep(wait_time)
            
            print(f"  🎬 Starting video generation (attempt {attempt+1})...")
            print(f"  📝 Prompt: {prompt[:80]}...")
            
            # Call Veo 3.1 image-to-video
            operation = client.models.generate_videos(
                model=MODEL,
                prompt=prompt,
                image={
                    "image_bytes": image_b64,
                    "mime_type": "image/png",
                },
                config={
                    "person_generation": "allow_adult",
                    "aspect_ratio": "16:9",
                },
            )
            
            # Poll until done
            elapsed = 0
            while not operation.done:
                time.sleep(10)
                elapsed += 10
                print(f"  ⏳ Generating... ({elapsed}s elapsed)")
                operation = client.operations.get(operation)
            
            # Save the video
            if operation.response and operation.response.generated_videos:
                video = operation.response.generated_videos[0]
                client.files.download(file=video.video)
                video.video.save(output_path)
                print(f"  ✅ Saved: {output_path}")
                return True
            else:
                print(f"  ❌ No video generated. Response: {operation.response}")
                return False
                
        except Exception as e:
            error_str = str(e)
            if "429" in error_str or "RESOURCE_EXHAUSTED" in error_str:
                if attempt < max_retries - 1:
                    print(f"  ⚠️  Rate limited. Will retry...")
                    continue
                else:
                    print(f"  ❌ Rate limited after {max_retries} attempts: {e}")
                    return False
            else:
                print(f"  ❌ Error: {e}")
                return False
    
    return False


def main():
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        print("❌ Error: GEMINI_API_KEY environment variable not set.")
        print("   Run: export GEMINI_API_KEY='your-key-here'")
        sys.exit(1)
    
    # Initialize client
    client = genai.Client(api_key=api_key)
    
    os.makedirs(VIDEOS_DIR, exist_ok=True)
    
    print("=" * 60)
    print("🎞️  Envision Legacy — Veo 3.1 Video Generator")
    print("=" * 60)
    print(f"📁 Images: {IMAGES_DIR}")
    print(f"📁 Output: {VIDEOS_DIR}")
    print(f"🤖 Model:  {MODEL}")
    print()
    
    total = len(PHOTO_DATA)
    generated = 0
    skipped = 0
    failed = 0
    
    for i, (image_file, prompt) in enumerate(PHOTO_DATA):
        image_path = os.path.join(IMAGES_DIR, image_file)
        video_name = os.path.splitext(image_file)[0] + ".mp4"
        output_path = os.path.join(VIDEOS_DIR, video_name)
        
        print(f"\n[{i+1}/{total}] {image_file}")
        
        # Skip if already generated
        if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
            print(f"  ⏭️  Already exists, skipping.")
            skipped += 1
            continue
        
        # Check source image exists
        if not os.path.exists(image_path):
            print(f"  ❌ Source image not found: {image_path}")
            failed += 1
            continue
        
        try:
            success = generate_video(client, image_path, prompt, output_path)
            if success:
                generated += 1
                # Cooldown between successful generations to avoid rate limits
                if i < total - 1:
                    print(f"  ⏸️  Cooling down 30s before next image...")
                    time.sleep(30)
            else:
                failed += 1
        except Exception as e:
            print(f"  ❌ Error: {e}")
            failed += 1
    
    print()
    print("=" * 60)
    print(f"🎬 Done! Generated: {generated} | Skipped: {skipped} | Failed: {failed}")
    print("=" * 60)


if __name__ == "__main__":
    main()
