'use strict';

function buildDarijaWriterPrompt(report) {
  if (!report || report.status !== 'completed' || !report.coverage || !report.coverage.complete)
    throw Error('A completed whole-video report is required for the writer');
  // This controlled comparison has one shared, verified video brief. A new production source
  // must receive its own grounded brief instead of inheriting this phone's facts.
  if (!report.source || String(report.source.videoId) !== '7541104872897219862')
    throw Error('This comparison brief belongs to the verified Galaxy A07 source only');
  return 'نتا كاتب إعلانات مغربي كتكتب غير بالدارجة المغربية الطبيعية وبالحروف العربية، بحال شي واحد كيهضر مع صاحبو. '
    + 'كتب سكريبت واحد ديال حوالي 30 ثانية، 60 حتى 85 كلمة: هوك فضولي وقوي فالأول، ربط طبيعي باللقطات، وفالأخير دعوة واضحة يدخل للرابط فالبايو، يشوف الاستبيانات المتاحة فـSurveoo، ويجاوب بصدق إلا لقى واحد مناسب ليه. '
    + 'الفيديو المؤكد كيبين يدين كيفتحو سكين صغير، كيقطعو تغليف علبة Samsung Galaxy A07، كيخرجو الهاتف البنفسجي، كيقلبوه وكيبينو الكابل والملحقات. '
    + 'ربط المشاهد بالرأي والاختيارات؛ ما تقولش الهاتف هدية ولا جائزة ولا بثمن رخيص، وما تخترعش ربح مضمون، مبلغ، ندرة، وقت الاستبيان أو فئة استبيان بعينها. '
    + 'استعمل دارجة مغربية صافية: شنو، علاش، دابا، بغيتي، ديالك، غير. بلا فصحى بحال يمكنك/لذلك/هذا/سوف، بلا لهجة مشرقية، بلا كلمات فرنسية أو إنجليزية إلا الاسم Surveoo. '
    + 'خرج غير الكلام اللي غادي يتقال بصوت طبيعي، بلا شرح وبلا عناوين.';
}
module.exports = { buildDarijaWriterPrompt };
