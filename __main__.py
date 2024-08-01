import os
import json
import googleapiclient.discovery
from nested_lookup import nested_lookup
from google.cloud import firestore

def main():
    # Disable OAuthlib's HTTPS verification when running locally.
    # *DO NOT* leave this option enabled in production.
    os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"
    #init variables
    api_service_name = "youtube"
    api_version = "v3"
    API_KEY = "AIzaSyCcrIQvSDBV7_LIBwV1xC0aG1o1HgLBxOk"
    channelid = "UC5RpnQM8-mvj_lDbM-P8Ggg"
    #sets up authenitcation method for YT API
    youtube = googleapiclient.discovery.build(
        api_service_name, api_version, developerKey = API_KEY)
    #initial request for channel details, must know channel id for now - looking into making this automated/more easily configurable
    channelrequest = youtube.channels().list(
        part="snippet,contentDetails,statistics",
        id=channelid,
        maxResults=50
        )
    channelresponse = channelrequest.execute()
    #saves JSON reponse to a .json file
    channelresponsejson = json.dumps(channelresponse, indent=4)
    with open("response.json", "w") as outfile:
        outfile.write(channelresponsejson)
    #finds uploads playlist id from the API response
    uploadid = nested_lookup('uploads', channelresponse)
    #removes the brackets from the extracted playlist id for use in the next lookup
    def listtostring(uploadid):
        str1 = ""
        return (str1.join(uploadid))
    strippeduploadid = listtostring(uploadid)
    #makes a request to yt for videoIds based on the playlistId and fills an array with the ids
    def getvideoids(youtube, strippeduploadid):
        video_ids = []
        videoidsrequest = youtube.playlistItems().list(part="snippet, contentDetails", playlistId=strippeduploadid, maxResults=50)
        videoidsresponse = videoidsrequest.execute()
        for item in videoidsresponse['items']:
             video_ids.append(item['contentDetails']['videoId'])
        next_page_token = videoidsresponse.get('nextPageToken')
        while next_page_token is not None:
            videoidsrequest = youtube.playlistItems().list(part="contentDetails", playlistId=strippeduploadid, maxResults=50,pageToken=next_page_token)
            videoidsresponse = videoidsrequest.execute()
            for item in videoidsresponse['items']:
                    video_ids.append(item['contentDetails']['videoId'])
            next_page_token = videoidsresponse.get('nextPageToken')
        return video_ids
    videoids = getvideoids(youtube, strippeduploadid)
    def listtodict(listObj):
        IDDict = {}
        for index, item in enumerate(listObj):
                IDDict[index] = item
        return IDDict
    IDDict = listtodict(videoids)
    IDString = json.loads(json.dumps(IDDict))

    db = firestore.Client(project='preaching247-b6740')

    # Add a new doc in collection 'cities' with ID 'LA'
    db.collection("YTVids").document(channelid).set(IDString)
    
if __name__ == "__main__":
    main()