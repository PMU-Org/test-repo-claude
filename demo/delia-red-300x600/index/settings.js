window.zones = {
    'top-right' : 'banner'
};
location.href.replace(/\[(.+?)=(.*?)]/g,function(all,name,value){
    window.zones[name] = value || void 0;
});
