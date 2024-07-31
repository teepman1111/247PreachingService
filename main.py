import os
import json
import googleapiclient.discovery
from nested_lookup import nested_lookup

def main():
    # Disable OAuthlib's HTTPS verification when running locally.
    # *DO NOT* leave this option enabled in production.
    os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"

    api_service_name = "youtube"
    api_version = "v3"
    API_KEY = "AIzaSyCcrIQvSDBV7_LIBwV1xC0aG1o1HgLBxOk"

    youtube = googleapiclient.discovery.build(
        api_service_name, api_version, developerKey = API_KEY)

    channelrequest = youtube.channels().list(
        part="snippet,contentDetails,statistics",
        id="UCTma8wm-HvEVbpxqu-YTlAw",
        maxResults=50
    )
    channelresponse = channelrequest.execute()
    channelresponsejson = json.dumps(channelresponse, indent=4)
    print(channelresponsejson)
    with open("response.json", "w") as outfile:
        outfile.write(channelresponsejson)
    
    uploadid = nested_lookup('uploads', channelresponsejson)

    print(uploadid)


if __name__ == "__main__":
    main()